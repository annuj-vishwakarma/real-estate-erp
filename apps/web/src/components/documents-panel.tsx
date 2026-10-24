import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Eye, FileImage, FileSpreadsheet, FileText, Paperclip, Trash2, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { ALLOWED_UPLOAD_TYPES, DOCUMENT_CATEGORIES, type DocumentEntityType } from '@erp/shared';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime, titleCase } from '@/lib/format';
import { useAuth } from '@/features/auth/auth-context';
import { Button } from './ui/button';
import { Card, CardContent, CardHeader, CardTitle, Select } from './ui/primitives';
import { ConfirmDialog } from './ui/overlays';
import { EmptyState, ErrorState } from './states';

interface Doc {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  category: string;
  createdAt: string;
  uploadedBy?: { name: string };
}

const MAX_MB = 15;
const ACCEPT = Object.keys(ALLOWED_UPLOAD_TYPES).join(',');

function fileIcon(mime: string) {
  if (mime.startsWith('image/')) return FileImage;
  if (mime.includes('sheet')) return FileSpreadsheet;
  return FileText;
}

function size(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Attachments for any record. Files go to private storage; viewing or downloading asks the
 * API for a short-lived signed link each time, after it re-checks access.
 */
export function DocumentsPanel({
  entityType,
  entityId,
  title = 'Documents',
  compact,
}: {
  entityType: DocumentEntityType;
  entityId: string;
  title?: string;
  compact?: boolean;
}) {
  const qc = useQueryClient();
  const { can } = useAuth();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [category, setCategory] = React.useState<string>('general');
  const [dragging, setDragging] = React.useState(false);
  const [toDelete, setToDelete] = React.useState<Doc | null>(null);
  const key = ['documents', entityType, entityId];
  const q = useQuery({
    queryKey: key,
    queryFn: () => api.get<Doc[]>('/documents', { entityType, entityId }),
    enabled: can('documents.read'),
  });

  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      for (const f of files) {
        if (!ALLOWED_UPLOAD_TYPES[f.type]) throw new Error(`${f.name}: only PDF, images, Word and Excel files are allowed`);
        if (f.size > MAX_MB * 1024 * 1024) throw new Error(`${f.name}: files may be at most ${MAX_MB} MB`);
      }
      for (const f of files) {
        const form = new FormData();
        form.append('entityType', entityType);
        form.append('entityId', entityId);
        form.append('category', category);
        form.append('file', f);
        await api.upload('/documents', form);
      }
      return files.length;
    },
    onSuccess: (n) => {
      qc.invalidateQueries({ queryKey: key });
      toast.success(`${n} file${n > 1 ? 's' : ''} uploaded`);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/documents/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: key });
      setToDelete(null);
      toast.success('Document removed');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const open = async (doc: Doc, disposition: 'inline' | 'attachment') => {
    try {
      const { url } = await api.get<{ url: string }>(`/documents/${doc.id}/url`, { disposition });
      if (disposition === 'inline') window.open(url, '_blank', 'noopener');
      else {
        const a = document.createElement('a');
        a.href = url;
        a.download = doc.fileName;
        a.rel = 'noopener';
        a.click();
      }
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  if (!can('documents.read')) return null;
  const canUpload = can('documents.upload');

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-2">
          <Paperclip className="size-4 text-muted-foreground" /> {title}
          {q.data && <span className="text-sm font-normal text-muted-foreground">({q.data.length})</span>}
        </CardTitle>
        {canUpload && (
          <div className="flex items-center gap-2">
            <Select className="h-8 w-36" value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Document category">
              {DOCUMENT_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {titleCase(c)}
                </option>
              ))}
            </Select>
            <Button size="sm" variant="outline" loading={upload.isPending} onClick={() => inputRef.current?.click()}>
              <Upload /> Upload
            </Button>
            <input
              ref={inputRef}
              type="file"
              accept={ACCEPT}
              multiple
              hidden
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                if (files.length) upload.mutate(files);
                e.target.value = '';
              }}
            />
          </div>
        )}
      </CardHeader>
      <CardContent
        onDragOver={(e) => {
          if (!canUpload) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          if (!canUpload) return;
          e.preventDefault();
          setDragging(false);
          const files = Array.from(e.dataTransfer.files);
          if (files.length) upload.mutate(files);
        }}
        className={dragging ? 'rounded-b-xl bg-accent/50 outline-2 outline-dashed outline-primary' : undefined}
      >
        {q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : !q.data ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : q.data.length === 0 ? (
          compact ? (
            <p className="text-sm text-muted-foreground">{canUpload ? 'No files yet. Drop files here or use Upload.' : 'No files.'}</p>
          ) : (
            <EmptyState
              title="No documents yet"
              description={canUpload ? 'Drop PDFs, images, Word or Excel files here (up to 15 MB each).' : undefined}
            />
          )
        ) : (
          <ul className="divide-y">
            {q.data.map((d) => {
              const Icon = fileIcon(d.mimeType);
              return (
                <li key={d.id} className="flex items-center gap-3 py-2.5">
                  <Icon className="size-5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{d.fileName}</p>
                    <p className="text-xs text-muted-foreground">
                      {titleCase(d.category)} · {size(d.sizeBytes)} · {d.uploadedBy?.name ?? ''} · {formatDateTime(d.createdAt)}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    {(d.mimeType === 'application/pdf' || d.mimeType.startsWith('image/')) && (
                      <Button variant="ghost" size="icon-sm" onClick={() => void open(d, 'inline')} aria-label={`View ${d.fileName}`}>
                        <Eye />
                      </Button>
                    )}
                    <Button variant="ghost" size="icon-sm" onClick={() => void open(d, 'attachment')} aria-label={`Download ${d.fileName}`}>
                      <Download />
                    </Button>
                    {can('documents.delete') && (
                      <Button variant="ghost" size="icon-sm" onClick={() => setToDelete(d)} aria-label={`Delete ${d.fileName}`}>
                        <Trash2 />
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
      <ConfirmDialog
        open={!!toDelete}
        onOpenChange={(o) => !o && setToDelete(null)}
        title={`Remove ${toDelete?.fileName}?`}
        description="The file is hidden from this record. A copy is retained for audit purposes."
        destructive
        confirmLabel="Remove"
        loading={remove.isPending}
        onConfirm={() => toDelete && remove.mutate(toDelete.id)}
      />
    </Card>
  );
}
