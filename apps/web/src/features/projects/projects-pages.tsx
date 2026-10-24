import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Archive, FolderPlus, Grid3x3, Map as MapIcon, Pencil, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { PROJECT_STATUSES, sqftToAreaX100 } from '@erp/shared';
import { api, errorMessage, fieldErrors } from '@/lib/api';
import { areaToSqft, formatDate, titleCase } from '@/lib/format';
import { useListParams } from '@/hooks/use-list-params';
import { useProjectContext } from '@/hooks/use-project';
import { Can, useAuth } from '@/features/auth/auth-context';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Select,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from '@/components/ui/primitives';
import { ConfirmDialog, Dialog, DialogContent, DialogFooter, Sheet, SheetContent } from '@/components/ui/overlays';
import { DescriptionList, Field, PageHeader, PLOT_STATUS_META, StatusBadge } from '@/components/common';
import { EmptyState, ErrorState, PageSkeleton } from '@/components/states';
import { SearchInput } from '@/components/search-input';
import { MoneyInput, paiseToInput, rupeeField, toPaise } from '@/components/money';
import { Skeleton } from '@/components/ui/primitives';
import { DocumentsPanel } from '@/components/documents-panel';

export interface Project {
  id: string;
  name: string;
  code: string;
  status: string;
  description?: string;
  reraNumber?: string;
  address?: { line1?: string; city?: string; state?: string; pincode?: string };
  launchDate?: string;
  totalAreaX100?: number;
  defaultRatePaisePerSqft?: number;
  map?: { width: number; height: number; backgroundColor: string };
  plotCounts?: Record<string, number>;
  totalPlots?: number;
  phases?: { id: string; name: string; code: string; sequence: number; startDate?: string; targetDate?: string }[];
  blocks?: { id: string; name: string; code: string; phaseId?: string }[];
}

const projectForm = z.object({
  name: z.string().trim().min(1, 'Project name is required').max(150),
  code: z
    .string()
    .trim()
    .min(1, 'Code is required')
    .max(20)
    .regex(/^[A-Za-z0-9-/]+$/, 'Letters, digits, - and / only'),
  status: z.enum(PROJECT_STATUSES),
  description: z.string().max(2000).optional(),
  reraNumber: z.string().max(60).optional(),
  line1: z.string().max(200).optional(),
  city: z.string().max(100).optional(),
  state: z.string().max(100).optional(),
  pincode: z
    .string()
    .regex(/^([1-9][0-9]{5})?$/, 'Enter a 6-digit PIN')
    .optional(),
  launchDate: z.string().optional(),
  totalArea: z
    .string()
    .regex(/^(\d+(\.\d{1,2})?)?$/, 'Square feet, up to 2 decimals')
    .optional(),
  defaultRate: rupeeField('Default rate', { required: false }),
});
type ProjectForm = z.infer<typeof projectForm>;

function toPayload(v: ProjectForm) {
  return {
    name: v.name,
    code: v.code.toUpperCase(),
    status: v.status,
    description: v.description || undefined,
    reraNumber: v.reraNumber || undefined,
    address: { line1: v.line1 || undefined, city: v.city || undefined, state: v.state || undefined, pincode: v.pincode || undefined },
    launchDate: v.launchDate || undefined,
    totalAreaX100: v.totalArea ? sqftToAreaX100(v.totalArea) : undefined,
    defaultRatePaisePerSqft: v.defaultRate ? toPaise(v.defaultRate) : undefined,
  };
}

export function ProjectFormSheet({
  open,
  onOpenChange,
  project,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  project?: Project;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const form = useForm<ProjectForm>({
    resolver: zodResolver(projectForm),
    values: {
      name: project?.name ?? '',
      code: project?.code ?? '',
      status: (project?.status as ProjectForm['status']) ?? 'planning',
      description: project?.description ?? '',
      reraNumber: project?.reraNumber ?? '',
      line1: project?.address?.line1 ?? '',
      city: project?.address?.city ?? '',
      state: project?.address?.state ?? '',
      pincode: project?.address?.pincode ?? '',
      launchDate: project?.launchDate?.slice(0, 10) ?? '',
      totalArea: project?.totalAreaX100 ? areaToSqft(project.totalAreaX100) : '',
      defaultRate: paiseToInput(project?.defaultRatePaisePerSqft),
    },
  });
  const save = useMutation({
    mutationFn: (v: ProjectForm) =>
      project ? api.patch<Project>(`/projects/${project.id}`, toPayload(v)) : api.post<Project>('/projects', toPayload(v)),
    onSuccess: (p) => {
      qc.invalidateQueries({ queryKey: ['projects'] });
      toast.success(project ? 'Project updated' : 'Project created');
      onOpenChange(false);
      if (!project) navigate(`/projects/${p.id}`);
    },
    onError: (err) => {
      const f = fieldErrors(err);
      Object.entries(f).forEach(([k, m]) => form.setError(k as keyof ProjectForm, { message: m }));
      if (!Object.keys(f).length) toast.error(errorMessage(err));
    },
  });
  const e = form.formState.errors;
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        title={project ? 'Edit project' : 'New project'}
        description="Projects group phases, blocks and plots."
        footer={
          <>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button form="project-form" type="submit" loading={save.isPending}>
              {project ? 'Save changes' : 'Create project'}
            </Button>
          </>
        }
      >
        <form id="project-form" className="grid gap-4 sm:grid-cols-2" onSubmit={form.handleSubmit((v) => save.mutate(v))} noValidate>
          <Field label="Project name" htmlFor="p-name" error={e.name?.message} required className="sm:col-span-2">
            <Input {...form.register('name')} />
          </Field>
          <Field label="Code" htmlFor="p-code" error={e.code?.message} hint="Short unique code, e.g. GVE" required>
            <Input {...form.register('code')} className="uppercase" />
          </Field>
          <Field label="Status" htmlFor="p-status" error={e.status?.message}>
            <Select {...form.register('status')}>
              {PROJECT_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {titleCase(s)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="RERA registration" htmlFor="p-rera" error={e.reraNumber?.message}>
            <Input {...form.register('reraNumber')} />
          </Field>
          <Field label="Launch date" htmlFor="p-launch" error={e.launchDate?.message}>
            <Input type="date" {...form.register('launchDate')} />
          </Field>
          <Field label="Total area (sq ft)" htmlFor="p-area" error={e.totalArea?.message}>
            <Input inputMode="decimal" {...form.register('totalArea')} />
          </Field>
          <Field label="Default rate (₹ / sq ft)" htmlFor="p-rate" error={e.defaultRate?.message}>
            <MoneyInput {...form.register('defaultRate')} />
          </Field>
          <Field label="Address" htmlFor="p-line1" error={e.line1?.message} className="sm:col-span-2">
            <Input {...form.register('line1')} />
          </Field>
          <Field label="City" htmlFor="p-city" error={e.city?.message}>
            <Input {...form.register('city')} />
          </Field>
          <Field label="State" htmlFor="p-state" error={e.state?.message}>
            <Input {...form.register('state')} />
          </Field>
          <Field label="PIN code" htmlFor="p-pin" error={e.pincode?.message}>
            <Input inputMode="numeric" {...form.register('pincode')} />
          </Field>
          <Field label="Description" htmlFor="p-desc" error={e.description?.message} className="sm:col-span-2">
            <Textarea rows={3} {...form.register('description')} />
          </Field>
        </form>
      </SheetContent>
    </Sheet>
  );
}

function InventoryBar({ counts, total }: { counts: Record<string, number>; total: number }) {
  if (!total) return <div className="h-2 rounded-full bg-muted" />;
  return (
    <div className="flex h-2 overflow-hidden rounded-full bg-muted" role="img" aria-label="Plot status distribution">
      {(Object.keys(PLOT_STATUS_META) as (keyof typeof PLOT_STATUS_META)[]).map((s) =>
        counts[s] ? <div key={s} style={{ width: `${(counts[s]! / total) * 100}%`, background: PLOT_STATUS_META[s].color }} /> : null,
      )}
    </div>
  );
}

export function ProjectsPage() {
  const lp = useListParams({ pageSize: 24 });
  const [creating, setCreating] = React.useState(false);
  const q = useQuery({
    queryKey: ['projects', 'list', lp.query, lp.filter('status')],
    queryFn: () => api.page<Project>('/projects', { ...lp.query, status: lp.filter('status') }),
  });
  return (
    <>
      <PageHeader
        title="Projects"
        description="Colonies and townships you are developing"
        actions={
          <Can permission="projects.create">
            <Button onClick={() => setCreating(true)}>
              <FolderPlus /> New project
            </Button>
          </Can>
        }
      />
      <div className="mb-4 flex flex-col gap-2 sm:flex-row">
        <SearchInput value={lp.q} onChange={lp.setQ} placeholder="Search name or code" />
        <Select
          className="sm:w-48"
          value={lp.filter('status') ?? ''}
          onChange={(e) => lp.setFilter('status', e.target.value || undefined)}
          aria-label="Status filter"
        >
          <option value="">All active statuses</option>
          {PROJECT_STATUSES.map((s) => (
            <option key={s} value={s}>
              {titleCase(s)}
            </option>
          ))}
        </Select>
      </div>
      {q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : q.isPending ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-44" />
          ))}
        </div>
      ) : q.data.items.length === 0 ? (
        <Card>
          <EmptyState
            icon={FolderPlus}
            title="No projects found"
            description="Create your first project to start adding plots."
            action={
              <Can permission="projects.create">
                <Button onClick={() => setCreating(true)}>
                  <Plus /> New project
                </Button>
              </Can>
            }
          />
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {q.data.items.map((p) => (
            <Link key={p.id} to={`/projects/${p.id}`} className="group rounded-xl focus-visible:outline-2 focus-visible:outline-ring">
              <Card className="h-full p-5 transition-shadow group-hover:shadow-md">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-semibold">{p.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {p.code}
                      {p.address?.city ? ` · ${p.address.city}` : ''}
                    </p>
                  </div>
                  <StatusBadge status={p.status} />
                </div>
                <div className="mt-5 space-y-2">
                  <InventoryBar counts={p.plotCounts ?? {}} total={p.totalPlots ?? 0} />
                  <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">{p.totalPlots ?? 0} plots</span>
                    {Object.entries(p.plotCounts ?? {}).map(([s, n]) => (
                      <span key={s}>
                        {n} {s}
                      </span>
                    ))}
                  </div>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
      <ProjectFormSheet open={creating} onOpenChange={setCreating} />
    </>
  );
}

const phaseForm = z.object({
  name: z.string().trim().min(1, 'Name is required').max(100),
  code: z
    .string()
    .trim()
    .min(1, 'Code is required')
    .max(20)
    .regex(/^[A-Za-z0-9-/]+$/, 'Letters, digits, - and /'),
  sequence: z.string().regex(/^\d{1,3}$/, '1–999'),
});
const blockForm = z.object({
  name: z.string().trim().min(1, 'Name is required').max(100),
  code: z
    .string()
    .trim()
    .min(1, 'Code is required')
    .max(20)
    .regex(/^[A-Za-z0-9-/]+$/, 'Letters, digits, - and /'),
  phaseId: z.string().optional(),
});

function PhasesAndBlocks({ project }: { project: Project }) {
  const qc = useQueryClient();
  const { can } = useAuth();
  const [phaseOpen, setPhaseOpen] = React.useState(false);
  const [blockOpen, setBlockOpen] = React.useState(false);
  const [toDelete, setToDelete] = React.useState<{ kind: 'phases' | 'blocks'; id: string; name: string } | null>(null);
  const pf = useForm<z.infer<typeof phaseForm>>({
    resolver: zodResolver(phaseForm),
    defaultValues: { sequence: String((project.phases?.length ?? 0) + 1) },
  });
  const bf = useForm<z.infer<typeof blockForm>>({ resolver: zodResolver(blockForm) });
  const refresh = () => qc.invalidateQueries({ queryKey: ['project', project.id] });

  const addPhase = useMutation({
    mutationFn: (v: z.infer<typeof phaseForm>) =>
      api.post(`/projects/${project.id}/phases`, { ...v, code: v.code.toUpperCase(), sequence: Number(v.sequence) }),
    onSuccess: () => {
      refresh();
      setPhaseOpen(false);
      pf.reset();
      toast.success('Phase added');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const addBlock = useMutation({
    mutationFn: (v: z.infer<typeof blockForm>) =>
      api.post(`/projects/${project.id}/blocks`, { ...v, code: v.code.toUpperCase(), phaseId: v.phaseId || undefined }),
    onSuccess: () => {
      refresh();
      setBlockOpen(false);
      bf.reset();
      toast.success('Block added');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (t: { kind: string; id: string }) => api.delete(`/projects/${project.id}/${t.kind}/${t.id}`),
    onSuccess: () => {
      refresh();
      setToDelete(null);
      toast.success('Deleted');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const canEdit = can('projects.update');

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>Phases</CardTitle>
          {canEdit && (
            <Button size="sm" variant="outline" onClick={() => setPhaseOpen(true)}>
              <Plus /> Add phase
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {!project.phases?.length ? (
            <EmptyState title="No phases" description="Phases are optional; use them to release a project in stages." />
          ) : (
            <ul className="divide-y">
              {project.phases.map((p) => (
                <li key={p.id} className="flex items-center justify-between py-2.5">
                  <div>
                    <p className="text-sm font-medium">
                      {p.sequence}. {p.name} <span className="text-muted-foreground">({p.code})</span>
                    </p>
                  </div>
                  {canEdit && (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Delete ${p.name}`}
                      onClick={() => setToDelete({ kind: 'phases', id: p.id, name: p.name })}
                    >
                      <Trash2 />
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>Blocks / sectors</CardTitle>
          {canEdit && (
            <Button size="sm" variant="outline" onClick={() => setBlockOpen(true)}>
              <Plus /> Add block
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {!project.blocks?.length ? (
            <EmptyState title="No blocks" description="Blocks group plots, e.g. Block A, Sector 3." />
          ) : (
            <ul className="divide-y">
              {project.blocks.map((b) => (
                <li key={b.id} className="flex items-center justify-between py-2.5">
                  <p className="text-sm font-medium">
                    {b.name} <span className="text-muted-foreground">({b.code})</span>
                    {b.phaseId && (
                      <span className="ml-2 text-xs text-muted-foreground">{project.phases?.find((p) => p.id === b.phaseId)?.name}</span>
                    )}
                  </p>
                  {canEdit && (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Delete ${b.name}`}
                      onClick={() => setToDelete({ kind: 'blocks', id: b.id, name: b.name })}
                    >
                      <Trash2 />
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Dialog open={phaseOpen} onOpenChange={setPhaseOpen}>
        <DialogContent title="Add phase">
          <form className="grid gap-4" onSubmit={pf.handleSubmit((v) => addPhase.mutate(v))} noValidate>
            <Field label="Name" htmlFor="ph-name" error={pf.formState.errors.name?.message} required>
              <Input {...pf.register('name')} placeholder="Phase 1" />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Code" htmlFor="ph-code" error={pf.formState.errors.code?.message} required>
                <Input {...pf.register('code')} placeholder="P1" className="uppercase" />
              </Field>
              <Field label="Sequence" htmlFor="ph-seq" error={pf.formState.errors.sequence?.message}>
                <Input inputMode="numeric" {...pf.register('sequence')} />
              </Field>
            </div>
            <DialogFooter>
              <Button type="submit" loading={addPhase.isPending}>
                Add phase
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={blockOpen} onOpenChange={setBlockOpen}>
        <DialogContent title="Add block">
          <form className="grid gap-4" onSubmit={bf.handleSubmit((v) => addBlock.mutate(v))} noValidate>
            <Field label="Name" htmlFor="bl-name" error={bf.formState.errors.name?.message} required>
              <Input {...bf.register('name')} placeholder="Block A" />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Code" htmlFor="bl-code" error={bf.formState.errors.code?.message} required>
                <Input {...bf.register('code')} placeholder="A" className="uppercase" />
              </Field>
              <Field label="Phase" htmlFor="bl-phase">
                <Select {...bf.register('phaseId')}>
                  <option value="">—</option>
                  {project.phases?.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <DialogFooter>
              <Button type="submit" loading={addBlock.isPending}>
                Add block
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={!!toDelete}
        onOpenChange={(o) => !o && setToDelete(null)}
        title={`Delete ${toDelete?.name}?`}
        description="This is only allowed when nothing references it."
        destructive
        confirmLabel="Delete"
        loading={remove.isPending}
        onConfirm={() => toDelete && remove.mutate(toDelete)}
      />
    </div>
  );
}

export function ProjectDetailPage() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { setProjectId } = useProjectContext();
  const [editing, setEditing] = React.useState(false);
  const [archiving, setArchiving] = React.useState(false);
  const q = useQuery({ queryKey: ['project', id], queryFn: () => api.get<Project>(`/projects/${id}`) });
  const archive = useMutation({
    mutationFn: () => api.post(`/projects/${id}/archive`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['projects'] });
      toast.success('Project archived');
      navigate('/projects');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (q.isPending) return <PageSkeleton />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const p = q.data;

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Projects', to: '/projects' }, { label: p.name }]}
        title={
          <span className="flex items-center gap-3">
            {p.name} <StatusBadge status={p.status} />
          </span>
        }
        description={`${p.code}${p.reraNumber ? ` · RERA ${p.reraNumber}` : ''}`}
        actions={
          <>
            <Button
              variant="outline"
              onClick={() => {
                setProjectId(p.id);
                navigate('/inventory');
              }}
            >
              <Grid3x3 /> Inventory
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setProjectId(p.id);
                navigate('/map');
              }}
            >
              <MapIcon /> Map
            </Button>
            <Can permission="projects.update">
              <Button variant="outline" onClick={() => setEditing(true)}>
                <Pencil /> Edit
              </Button>
            </Can>
            <Can permission="projects.archive">
              {p.status !== 'archived' && (
                <Button variant="ghost" onClick={() => setArchiving(true)} aria-label="Archive project">
                  <Archive />
                </Button>
              )}
            </Can>
          </>
        }
      />
      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="structure">Phases & blocks</TabsTrigger>
          <TabsTrigger value="documents">Documents</TabsTrigger>
        </TabsList>
        <TabsContent value="overview">
          <Card>
            <CardContent className="pt-5">
              <DescriptionList
                items={[
                  {
                    label: 'Address',
                    value: [p.address?.line1, p.address?.city, p.address?.state, p.address?.pincode].filter(Boolean).join(', ') || '—',
                  },
                  { label: 'Launch date', value: p.launchDate ? formatDate(p.launchDate.slice(0, 10)) : '—' },
                  { label: 'Total area', value: p.totalAreaX100 ? `${areaToSqft(p.totalAreaX100)} sq ft` : '—' },
                  { label: 'Default rate', value: p.defaultRatePaisePerSqft ? `₹${paiseToInput(p.defaultRatePaisePerSqft)} / sq ft` : '—' },
                  { label: 'Phases', value: p.phases?.length ?? 0 },
                  { label: 'Blocks', value: p.blocks?.length ?? 0 },
                ]}
              />
              {p.description && <p className="mt-5 whitespace-pre-line text-sm text-muted-foreground">{p.description}</p>}
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="structure">
          <PhasesAndBlocks project={p} />
        </TabsContent>
        <TabsContent value="documents">
          <DocumentsPanel entityType="project" entityId={p.id} title="Approvals, layout plans & project documents" />
        </TabsContent>
      </Tabs>
      <ProjectFormSheet open={editing} onOpenChange={setEditing} project={p} />
      <ConfirmDialog
        open={archiving}
        onOpenChange={setArchiving}
        title="Archive this project?"
        description="Archived projects are hidden from selectors and cannot take new plots. Projects with reserved or booked plots cannot be archived."
        confirmLabel="Archive"
        destructive
        loading={archive.isPending}
        onConfirm={() => archive.mutate()}
      />
    </>
  );
}
