import React from 'react';
import { Radio, Square, RefreshCw, Power, MemoryStick } from 'lucide-react';
import Card from '../ui/Card';
import Badge from '../ui/Badge';

/**
 * What this machine is serving right now, one row per lane, each stoppable.
 *
 * Every row stops only its own workflow (owner, 2026-10-21). Closing an extra
 * lane gives its VRAM back at once. Stopping the PRIMARY lane while others serve
 * promotes the next one (a restart, asked first by AdminConfig); only the last
 * workflow going puts the machine in admin mode. The header's "Reset to admin"
 * is the one that stops everything.
 *
 * Empty whenever nothing is served, which is the honest reading of an admin-mode
 * machine: it answers HTTP and schedules nothing.
 */
const RunningWorkflows = ({
    lanes = [], card = null, serving = false,
    onCloseLane = null, closingLaneId = null,
    onDeactivate = null, deactivating = false,
}) => {
    const free = card?.vramGb
        ? Math.max(0, +(card.vramGb - card.usedGb - 2).toFixed(2))
        : null;

    return (
        <Card>
            <div className="flex items-center justify-between mb-3">
                <h2 className="text-lg font-semibold flex items-center gap-2">
                    <Radio size={18} /> Running
                </h2>
                <Badge variant={lanes.length ? 'success' : 'default'}>
                    {lanes.length
                        ? `${lanes.length} workflow${lanes.length > 1 ? 's' : ''} served`
                        : 'Nothing served'}
                </Badge>
            </div>

            {lanes.length === 0 ? (
                <p className="text-sm text-muted">
                    This machine is not serving a workflow, so students cannot book anything on it.
                    Pick one in the library below and use <span className="text-foreground">Activate &amp; serve</span>.
                </p>
            ) : (
                <>
                    {card?.vramGb && (
                        <p className="text-xs text-muted mb-3">
                            {card.usedGb} of {card.vramGb} GB of models resident
                            {free !== null && <> · {free} GB free for another workflow</>}
                        </p>
                    )}
                    <div className="space-y-2">
                        {lanes.map(l => {
                            const closing = closingLaneId === l.workflowId;
                            return (
                                <div key={l.workflowId}
                                    className="flex items-center gap-3 flex-wrap px-3 py-2 rounded-lg bg-surface border border-border">
                                    <span className="inline-flex items-center gap-1.5 text-success flex-shrink-0">
                                        <Radio size={13} />
                                        <span className="text-sm font-medium text-foreground">{l.name}</span>
                                    </span>
                                    {l.primary && <Badge variant="primary">primary</Badge>}
                                    {l.busy && <Badge variant="success">generating</Badge>}
                                    <code className="text-xs text-muted">{l.workflowId}</code>
                                    <span className="text-xs text-muted">:{l.port}</span>
                                    {l.vramGb != null && (
                                        <span className="inline-flex items-center gap-1 text-xs text-muted">
                                            <MemoryStick size={11} />{l.vramGb} GB
                                        </span>
                                    )}

                                    {/* An extra lane just goes. The primary one going means the
                                        machine stops serving, so it gets the heavier label. */}
                                    {l.primary ? (
                                        serving && onDeactivate && (
                                            <button
                                                type="button"
                                                disabled={deactivating}
                                                onClick={() => onDeactivate(l.workflowId)}
                                                className="ml-auto inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-background border border-border hover:border-danger/50 text-muted hover:text-danger transition-colors disabled:opacity-60 disabled:cursor-wait"
                                                title={lanes.length > 1 ? 'Stop serving this workflow — the others keep serving (the machine restarts, about a minute).' : 'Stop serving — puts the server back in admin mode, so students can no longer book on this machine.'}
                                            >
                                                {deactivating ? <RefreshCw size={13} className="animate-spin" /> : <Power size={13} />}
                                                <span>{deactivating ? 'Stopping…' : 'Stop serving'}</span>
                                            </button>
                                        )
                                    ) : onCloseLane && (
                                        <button
                                            type="button"
                                            disabled={closing}
                                            onClick={() => onCloseLane(l.workflowId)}
                                            className="ml-auto inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-background border border-border hover:border-danger/50 text-muted hover:text-danger transition-colors disabled:opacity-60 disabled:cursor-wait"
                                            title="Stop this lane and give its VRAM back. The machine keeps serving the others."
                                        >
                                            {closing ? <RefreshCw size={13} className="animate-spin" /> : <Square size={13} />}
                                            <span>{closing ? 'Closing…' : 'Close lane'}</span>
                                        </button>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </>
            )}
        </Card>
    );
};

export default RunningWorkflows;
