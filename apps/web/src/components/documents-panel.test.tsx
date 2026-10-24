import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const perms = new Set<string>();
vi.mock('@/features/auth/auth-context', () => ({
  useAuth: () => ({ can: (p: string) => perms.has(p) }),
}));

const get = vi.fn();
const upload = vi.fn();
vi.mock('@/lib/api', () => ({
  api: { get: (...a: unknown[]) => get(...a), upload: (...a: unknown[]) => upload(...a), delete: vi.fn() },
  errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

const toastError = vi.fn();
vi.mock('sonner', () => ({ toast: { error: (m: string) => toastError(m), success: vi.fn() } }));

import { DocumentsPanel } from './documents-panel';

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <DocumentsPanel entityType="land_parcel" entityId="abc" title="Title documents" />
    </QueryClientProvider>,
  );
}

describe('DocumentsPanel', () => {
  beforeEach(() => {
    perms.clear();
    get.mockReset();
    upload.mockReset();
    toastError.mockReset();
  });

  it('renders nothing without documents.read', () => {
    const { container } = renderPanel();
    expect(container).toBeEmptyDOMElement();
    expect(get).not.toHaveBeenCalled();
  });

  it('lists files and hides upload/delete without those permissions', async () => {
    perms.add('documents.read');
    get.mockResolvedValue([
      {
        id: 'd1',
        fileName: 'sale-deed.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 2048,
        category: 'registry',
        createdAt: new Date().toISOString(),
      },
    ]);
    renderPanel();
    expect(await screen.findByText('sale-deed.pdf')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'View sale-deed.pdf' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Upload/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete sale-deed.pdf' })).not.toBeInTheDocument();
  });

  it('rejects disallowed file types before uploading', async () => {
    perms.add('documents.read').add('documents.upload');
    get.mockResolvedValue([]);
    const { container } = renderPanel();
    await screen.findByText('No documents yet');
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    await userEvent.upload(input, new File(['x'], 'run.exe', { type: 'application/x-msdownload' }), { applyAccept: false });
    await vi.waitFor(() => expect(toastError).toHaveBeenCalledWith(expect.stringContaining('only PDF')));
    expect(upload).not.toHaveBeenCalled();
  });
});
