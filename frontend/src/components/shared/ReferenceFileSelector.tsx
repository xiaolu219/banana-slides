import React, { useState, useEffect, useRef } from 'react';
import { FileText, Upload, X, Loader2, CheckCircle2, XCircle, RefreshCw } from 'lucide-react';
import { Button, useToast, Modal } from '@/components/shared';
import {
  listProjectReferenceFiles,
  uploadReferenceFile,
  deleteReferenceFile,
  getReferenceFile,
  triggerFileParse,
  type ReferenceFile,
} from '@/api/endpoints';

interface ReferenceFileSelectorProps {
  projectId?: string | null; // 可选，如果不提供则使用全局文件
  isOpen: boolean;
  onClose: () => void;
  onSelect: (files: ReferenceFile[]) => void;
  multiple?: boolean; // 是否支持多选
  maxSelection?: number; // 最大选择数量
  initialSelectedIds?: string[]; // 初始已选择的文件ID列表
}

/**
 * 参考文件选择器组件
 * - 浏览项目下的所有参考文件
 * - 支持单选/多选
 * - 支持上传本地文件
 * - 支持从文件库选择（已解析的直接用，未解析的选中后当场解析）
 * - 支持删除文件
 */
export const ReferenceFileSelector: React.FC<ReferenceFileSelectorProps> = React.memo(({
  projectId,
  isOpen,
  onClose,
  onSelect,
  multiple = true,
  maxSelection,
  initialSelectedIds = [],
}) => {
  const { show } = useToast();
  const [files, setFiles] = useState<ReferenceFile[]>([]);
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [parsingIds, setParsingIds] = useState<Set<string>>(new Set());
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      loadFiles();
      // 恢复初始选择
      setSelectedFiles(new Set(initialSelectedIds));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, projectId]); // 移除 initialSelectedIds 依赖，避免无限循环

  // 轮询解析状态
  useEffect(() => {
    if (!isOpen || parsingIds.size === 0) return;

    const intervalId = setInterval(async () => {
      const idsToCheck = Array.from(parsingIds);
      const updatedFiles: ReferenceFile[] = [];
      const completedIds: string[] = [];

      for (const fileId of idsToCheck) {
        try {
          const response = await getReferenceFile(fileId);
          if (response.data?.file) {
            const updatedFile = response.data.file;
            updatedFiles.push(updatedFile);
            
            // 如果解析完成或失败，标记为完成
            if (updatedFile.parse_status === 'completed' || updatedFile.parse_status === 'failed') {
              completedIds.push(fileId);
            }
          }
        } catch (error) {
          console.error(`Failed to poll file ${fileId}:`, error);
        }
      }

      // 批量更新文件列表
      if (updatedFiles.length > 0) {
        setFiles(prev => {
          const fileMap = new Map(prev.map(f => [f.id, f]));
          updatedFiles.forEach(uf => fileMap.set(uf.id, uf));
          return Array.from(fileMap.values());
        });
      }

      // 从轮询列表中移除已完成的文件
      if (completedIds.length > 0) {
        setParsingIds(prev => {
          const newSet = new Set(prev);
          completedIds.forEach(id => newSet.delete(id));
          return newSet;
        });
      }
    }, 2000); // 每2秒轮询一次

    return () => clearInterval(intervalId);
  }, [isOpen, parsingIds]);

  const loadFiles = async () => {
    setIsLoading(true);
    try {
      const targetProjectId = projectId || 'global';
      const response = await listProjectReferenceFiles(targetProjectId);
      if (response.data?.files) {
        setFiles(response.data.files);
      }
    } catch (error: any) {
      console.error('加载参考文件列表失败:', error);
      show({
        message: error?.response?.data?.error?.message || error.message || '加载参考文件列表失败',
        type: 'error',
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleSelectFile = (file: ReferenceFile) => {
    // 允许选择所有状态的文件（包括 pending 和 parsing）
    // pending 的文件会在确定时触发解析
    // parsing 的文件会等待解析完成

    if (multiple) {
      const newSelected = new Set(selectedFiles);
      if (newSelected.has(file.id)) {
        newSelected.delete(file.id);
      } else {
        if (maxSelection && newSelected.size >= maxSelection) {
          show({
            message: `最多只能选择 ${maxSelection} 个文件`,
            type: 'info',
          });
          return;
        }
        newSelected.add(file.id);
      }
      setSelectedFiles(newSelected);
    } else {
      setSelectedFiles(new Set([file.id]));
    }
  };

  const handleConfirm = async () => {
    const selected = files.filter((f) => selectedFiles.has(f.id));
    
    if (selected.length === 0) {
      show({ message: '请至少选择一个文件', type: 'info' });
      return;
    }
    
    // 检查是否有未解析的文件需要触发解析
    const unparsedFiles = selected.filter(f => f.parse_status === 'pending');
    
    if (unparsedFiles.length > 0) {
      // 触发解析未解析的文件，但立即返回（不等待）
      try {
        show({
          message: `已触发 ${unparsedFiles.length} 个文件的解析，将在后台进行`,
          type: 'success',
        });

        // 触发所有未解析文件的解析（不等待完成）
        unparsedFiles.forEach(file => {
          triggerFileParse(file.id).catch(error => {
            console.error(`触发文件 ${file.filename} 解析失败:`, error);
          });
        });
        
        // 立即返回所有选中的文件（包括 pending 状态的）
        onSelect(selected);
        onClose();
      } catch (error: any) {
        console.error('触发文件解析失败:', error);
        show({
          message: error?.response?.data?.error?.message || error.message || '触发文件解析失败',
          type: 'error',
        });
      }
    } else {
      // 所有文件都已解析或正在解析，直接确认
      // 允许选择所有状态的文件（completed, parsing）
      const validFiles = selected.filter(f => 
        f.parse_status === 'completed' || f.parse_status === 'parsing'
      );
      
      if (validFiles.length === 0) {
        show({ message: '请选择有效的文件', type: 'warning' });
        return;
      }
      
      onSelect(validFiles);
      onClose();
    }
  };

  const handleClear = () => {
    setSelectedFiles(new Set());
  };

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    setIsUploading(true);
    try {
      // 上传所有选中的文件
      const uploadPromises = Array.from(files).map(file =>
        uploadReferenceFile(file, projectId)
      );

      const results = await Promise.all(uploadPromises);
      const uploadedFiles = results
        .map(r => r.data?.file)
        .filter((f): f is ReferenceFile => f !== undefined);

      if (uploadedFiles.length > 0) {
        show({ message: `成功上传 ${uploadedFiles.length} 个文件`, type: 'success' });
        
        // 只有正在解析的文件才添加到轮询列表（pending 状态的文件不轮询）
        const needsParsing = uploadedFiles.filter(f => 
          f.parse_status === 'parsing'
        );
        if (needsParsing.length > 0) {
          setParsingIds(prev => {
            const newSet = new Set(prev);
            needsParsing.forEach(f => newSet.add(f.id));
            return newSet;
          });
        }
        
        loadFiles(); // 重新加载文件列表
      }
    } catch (error: any) {
      console.error('上传文件失败:', error);
      show({
        message: error?.response?.data?.error?.message || error.message || '上传文件失败',
        type: 'error',
      });
    } finally {
      setIsUploading(false);
      // 清空 input 值，以便可以重复选择同一文件
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const handleDeleteFile = async (
    e: React.MouseEvent<HTMLButtonElement, MouseEvent>,
    file: ReferenceFile
  ) => {
    e.stopPropagation();
    const fileId = file.id;

    if (!fileId) {
      show({ message: '无法删除：缺少文件ID', type: 'error' });
      return;
    }

    setDeletingIds((prev) => {
      const newSet = new Set(prev);
      newSet.add(fileId);
      return newSet;
    });

    try {
      await deleteReferenceFile(fileId);
      show({ message: '文件删除成功', type: 'success' });
      
      // 从选择中移除
      setSelectedFiles((prev) => {
        const newSet = new Set(prev);
        newSet.delete(fileId);
        return newSet;
      });
      
      // 从轮询列表中移除
      setParsingIds((prev) => {
        const newSet = new Set(prev);
        newSet.delete(fileId);
        return newSet;
      });
      
      loadFiles(); // 重新加载文件列表
    } catch (error: any) {
      console.error('删除文件失败:', error);
      show({
        message: error?.response?.data?.error?.message || error.message || '删除文件失败',
        type: 'error',
      });
    } finally {
      setDeletingIds((prev) => {
        const newSet = new Set(prev);
        newSet.delete(fileId);
        return newSet;
      });
    }
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const getStatusIcon = (file: ReferenceFile) => {
    if (parsingIds.has(file.id) || file.parse_status === 'parsing') {
      return <Loader2 className="w-4 h-4 text-blue-500 animate-spin" />;
    }
    switch (file.parse_status) {
      case 'completed':
        return <CheckCircle2 className="w-4 h-4 text-green-500" />;
      case 'failed':
        return <XCircle className="w-4 h-4 text-red-500" />;
      default:
        return null;
    }
  };

  const getStatusText = (file: ReferenceFile) => {
    if (parsingIds.has(file.id) || file.parse_status === 'parsing') {
      return '解析中...';
    }
    switch (file.parse_status) {
      case 'pending':
        return '等待解析';
      case 'completed':
        return '解析完成';
      case 'failed':
        return '解析失败';
      default:
        return '';
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="选择参考文件" size="lg">
      <div className="space-y-4">
        {/* 操作栏 */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              icon={<Upload size={16} />}
              onClick={() => fileInputRef.current?.click()}
              disabled={isUploading}
            >
              {isUploading ? '上传中...' : '上传文件'}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              icon={<RefreshCw size={16} />}
              onClick={loadFiles}
              disabled={isLoading}
            >
              刷新
            </Button>
          </div>
          {selectedFiles.size > 0 && (
            <div className="flex items-center gap-2">
              <span className="text-sm text-gray-600">
                已选择 {selectedFiles.size} 个文件
              </span>
              <Button variant="ghost" size="sm" onClick={handleClear}>
                清空
              </Button>
            </div>
          )}
        </div>

        {/* 隐藏的文件输入 */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.csv,.txt,.md"
          onChange={handleUpload}
          className="hidden"
        />

        {/* 文件列表 */}
        <div className="border border-gray-200 rounded-lg max-h-96 overflow-y-auto">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-6 h-6 text-gray-400 animate-spin" />
              <span className="ml-2 text-gray-500">加载中...</span>
            </div>
          ) : files.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-gray-400">
              <FileText className="w-12 h-12 mb-2" />
              <p>暂无参考文件</p>
              <p className="text-sm mt-1">点击"上传文件"按钮添加文件</p>
            </div>
          ) : (
            <div className="divide-y divide-gray-200">
              {files.map((file) => {
                const isSelected = selectedFiles.has(file.id);
                const isDeleting = deletingIds.has(file.id);
                const isParsing = parsingIds.has(file.id) || file.parse_status === 'parsing';
                const isPending = file.parse_status === 'pending';
                const canSelect = true; // 允许选择所有状态的文件

                return (
                  <div
                    key={file.id}
                    onClick={() => handleSelectFile(file)}
                    className={`
                      p-4 cursor-pointer transition-colors
                      ${isSelected ? 'bg-banana-50 border-l-4 border-l-banana-500' : 'hover:bg-gray-50'}
                      ${file.parse_status === 'failed' ? 'opacity-60' : ''}
                    `}
                  >
                    <div className="flex items-start gap-3">
                      {/* 选择框 */}
                      <div className="flex-shrink-0 mt-1">
                        <div
                          className={`
                            w-5 h-5 rounded border-2 flex items-center justify-center
                            ${isSelected
                              ? 'bg-banana-500 border-banana-500'
                              : 'border-gray-300'
                            }
                            ${file.parse_status === 'failed' ? 'opacity-50' : ''}
                          `}
                        >
                          {isSelected && (
                            <CheckCircle2 className="w-4 h-4 text-white" />
                          )}
                        </div>
                      </div>

                      {/* 文件图标 */}
                      <div className="flex-shrink-0">
                        <div className="w-10 h-10 bg-blue-50 rounded-lg flex items-center justify-center">
                          <FileText className="w-5 h-5 text-blue-600" />
                        </div>
                      </div>

                      {/* 文件信息 */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium text-gray-900 truncate">
                            {file.filename}
                          </p>
                          <span className="text-xs text-gray-500 flex-shrink-0">
                            {formatFileSize(file.file_size)}
                          </span>
                        </div>

                        {/* 状态 */}
                        <div className="flex items-center gap-1.5 mt-1">
                          {getStatusIcon(file)}
                          <p className="text-xs text-gray-600">
                            {getStatusText(file)}
                            {isPending && (
                              <span className="ml-1 text-orange-500">(确定后解析)</span>
                            )}
                          </p>
                        </div>

                        {/* 失败信息 */}
                        {file.parse_status === 'failed' && file.error_message && (
                          <p className="text-xs text-red-500 mt-1 line-clamp-1">
                            {file.error_message}
                          </p>
                        )}

                        {/* 图片识别失败警告 */}
                        {file.parse_status === 'completed' && 
                         typeof file.image_caption_failed_count === 'number' && 
                         file.image_caption_failed_count > 0 && (
                          <p className="text-xs text-orange-500 mt-1">
                            ⚠️ {file.image_caption_failed_count} 张图片未能生成描述
                          </p>
                        )}
                      </div>

                      {/* 删除按钮 */}
                      <button
                        onClick={(e) => handleDeleteFile(e, file)}
                        disabled={isDeleting}
                        className="flex-shrink-0 p-1 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors disabled:opacity-50"
                        title="删除文件"
                      >
                        {isDeleting ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <X className="w-4 h-4" />
                        )}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* 底部操作栏 */}
        <div className="flex items-center justify-between pt-4 border-t border-gray-200">
          <p className="text-xs text-gray-500">
            💡 提示：选择未解析的文件将自动开始解析
          </p>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={onClose}>
              取消
            </Button>
            <Button
              onClick={handleConfirm}
              disabled={selectedFiles.size === 0}
            >
              确定 ({selectedFiles.size})
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
});

