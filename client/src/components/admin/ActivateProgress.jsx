import React, { useEffect, useState } from 'react';
import { Download, CheckCircle2, AlertTriangle, Loader2 } from 'lucide-react';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import { SERVER_URL } from '../../utils/api';

// "Activate & serve" on a workflow with models missing: the server downloads
// them first (the same plan a launch with this workflow runs, server/cloud/
// podPlan.js), then switches to serving by itself. This window follows it from
// GET /admin/pod-plan: one row per model file, then serving — or why not.
const gb = (b) => (Number(b || 0) / 1024 ** 3).toFixed(1);

export default function ActivateProgress({ workflowId, missing = [], onClose, onServeAnyway }) {
    const [plan, setPlan] = useState(null);
    const [gone, setGone] = useState(false);   // the server restarted into serving

    useEffect(() => {
        let stop = false, timer;
        const poll = async () => {
            try {
                const r = await fetch(`${SERVER_URL}/admin/pod-plan`, { cache: 'no-store' });
                const d = await r.json();
                if (!stop) setPlan(d.plan);
                if (d.plan?.status === 'done') { setTimeout(() => window.location.assign('/user'), 4000); return; }
                if (d.plan?.status === 'failed' || d.plan?.status === 'refused') return;
            } catch {
                // The server restarts once the models are in: that is the good end.
                if (!stop && plan?.status === 'done') setGone(true);
            }
            if (!stop) timer = setTimeout(poll, 2000);
        };
        poll();
        return () => { stop = true; clearTimeout(timer); };
    }, []);   // eslint-disable-line react-hooks/exhaustive-deps

    const files = plan?.files || [];
    const status = plan?.status || 'pending';
    const failed = status === 'failed' || status === 'refused';
    const done = status === 'done' || gone;
    const total = files.reduce((a, f) => a + (Number(f.total) || 0), 0);
    const got = files.reduce((a, f) => a + (f.status === 'done' ? (Number(f.total) || Number(f.received) || 0) : (Number(f.received) || 0)), 0);
    const pct = total ? Math.min(100, Math.round(100 * got / total)) : 0;

    return (
        <Modal isOpen onClose={failed || done ? onClose : () => {}} title={`Getting ${workflowId} ready`} maxWidth="max-w-xl">
            <div className="space-y-4">
                {!failed && !done && (
                    <p className="text-sm text-foreground flex items-center gap-2">
                        <Loader2 className="w-4 h-4 animate-spin" />
                        {files.length
                            ? `Downloading ${files.filter(f => f.status !== 'done' && f.status !== 'skipped').length} of ${files.length} model file(s) this workflow needs${total ? ` — ${gb(got)} of ${gb(total)} GB (${pct}%)` : ''}.`
                            : `This machine is missing ${missing.length} model file(s) for this workflow: getting the download ready…`}
                    </p>
                )}
                {done && (
                    <p className="text-sm text-foreground flex items-center gap-2"><CheckCircle2 className="w-4 h-4 text-success" />
                        Every model is in. The machine is switching to serving {workflowId}; the student page opens in a moment.</p>
                )}
                {failed && (
                    <div className="text-sm text-foreground space-y-1">
                        <p className="flex items-center gap-2 font-medium"><AlertTriangle className="w-4 h-4 text-danger" /> The models could not all be downloaded, so the machine is not serving.</p>
                        <p className="text-muted">{plan?.error}</p>
                    </div>
                )}
                {total > 0 && !done && (
                    <div className="h-1.5 rounded bg-border overflow-hidden"><div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} /></div>
                )}
                {files.length > 0 && (
                    <ul className="text-xs space-y-1.5 max-h-64 overflow-y-auto">
                        {files.map(f => (
                            <li key={f.name} className="flex items-center gap-2">
                                {f.status === 'done' ? <CheckCircle2 className="w-3.5 h-3.5 text-success shrink-0" />
                                    : f.status === 'failed' ? <AlertTriangle className="w-3.5 h-3.5 text-danger shrink-0" />
                                    : <Download className="w-3.5 h-3.5 text-muted shrink-0" />}
                                <span className="truncate flex-1 font-mono">{f.name}</span>
                                <span className="text-muted whitespace-nowrap">
                                    {f.status === 'downloading' && f.total ? `${gb(f.received)} / ${gb(f.total)} GB`
                                        : f.status === 'skipped' ? 'fetched by its node pack'
                                        : f.status === 'waiting' ? `waiting for ${f.waitingFor || 'another machine'}`
                                        : f.error ? f.error : f.status}
                                </span>
                            </li>
                        ))}
                    </ul>
                )}
                <p className="text-xs text-muted">This window can stay open; the download runs on the machine, not in this page.</p>
                {failed && (
                    <div className="flex justify-end gap-2 pt-2 border-t border-border">
                        <Button variant="ghost" onClick={onClose}>Close</Button>
                        <Button variant="danger" onClick={onServeAnyway}>Serve anyway (jobs needing these models will fail)</Button>
                    </div>
                )}
            </div>
        </Modal>
    );
}
