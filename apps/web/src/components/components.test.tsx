import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { DataTable, type Column } from './data-table';
import { StatusBadge } from './common';
import { ErrorState } from './states';
import { ApiError } from '@/lib/api';
import { toBp, toPaise } from './money';

interface Row {
  id: string;
  name: string;
  amount: number;
}
const columns: Column<Row>[] = [
  { key: 'name', header: 'Name', sortKey: 'name', cell: (r) => r.name },
  { key: 'amount', header: 'Amount', align: 'right', cell: (r) => r.amount },
];

describe('DataTable', () => {
  it('renders rows, pagination and cycles server-side sort', async () => {
    const onSort = vi.fn();
    const onPage = vi.fn();
    const { rerender } = render(
      <DataTable
        columns={columns}
        rows={[{ id: '1', name: 'Plot A-1', amount: 10 }]}
        rowKey={(r) => r.id}
        meta={{ page: 1, pageSize: 1, total: 3, totalPages: 3 }}
        onPageChange={onPage}
        onSortChange={onSort}
      />,
    );
    expect(screen.getByText('Plot A-1')).toBeInTheDocument();
    expect(screen.getByText('1–1 of 3')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /name/i }));
    expect(onSort).toHaveBeenLastCalledWith('name');
    rerender(<DataTable columns={columns} rows={[]} rowKey={(r) => r.id} sort="name" onSortChange={onSort} />);
    await userEvent.click(screen.getByRole('button', { name: /name/i }));
    expect(onSort).toHaveBeenLastCalledWith('-name');
    expect(screen.getByText('Nothing here yet')).toBeInTheDocument();
  });

  it('pages forward', async () => {
    const onPage = vi.fn();
    render(
      <DataTable
        columns={columns}
        rows={[{ id: '1', name: 'x', amount: 1 }]}
        rowKey={(r) => r.id}
        meta={{ page: 1, pageSize: 1, total: 2, totalPages: 2 }}
        onPageChange={onPage}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(onPage).toHaveBeenCalledWith(2);
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled();
  });
});

describe('StatusBadge', () => {
  it('labels plot statuses with text, not colour alone', () => {
    render(<StatusBadge status="reserved" kind="plot" />);
    expect(screen.getByText('Reserved')).toBeInTheDocument();
  });
});

describe('ErrorState', () => {
  it('shows a permission-denied screen for 403 responses', () => {
    render(
      <MemoryRouter>
        <ErrorState error={new ApiError(403, 'FORBIDDEN', 'Nope')} />
      </MemoryRouter>,
    );
    expect(screen.getByText('You don’t have access to this')).toBeInTheDocument();
  });
  it('offers retry for server errors', async () => {
    const retry = vi.fn();
    render(<ErrorState error={new ApiError(500, 'INTERNAL', 'Boom', undefined, 'req-1')} onRetry={retry} />);
    expect(screen.getByText('Reference: req-1')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(retry).toHaveBeenCalled();
  });
});

describe('money inputs', () => {
  it('converts rupee and percent strings without floating point', () => {
    expect(toPaise('1,25,000.10')).toBe(12_500_010);
    expect(toPaise('')).toBe(0);
    expect(toBp('12.5')).toBe(1_250);
  });
});
