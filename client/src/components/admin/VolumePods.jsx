import React, { useEffect, useState } from 'react';
import { Users, HardDrive } from 'lucide-react';
import { SERVER_URL } from '../../utils/api';

/**
 * Who else is using this network volume (Phase I4).
 *
 * Several Pods can share one volume, and the models on it are shared too. So
 * while another Pod is up, pruning, restoring from quarantine and emptying the
 * quarantine are refused: the usage scan only knows THIS Pod's workflows, and
 * a weight it calls unused may be loaded by the other one. This line is what
 * makes such a refusal unsurprising.
 *
 * Renders nothing off a shared volume (a lab rig, `npm run dev`).
 */
const VolumePods = () => {
    const [data, setData] = useState(null);

    useEffect(() => {
        let alive = true;
        const load = async () => {
            try {
                const res = await fetch(`${SERVER_URL}/admin/volume-pods`);
                if (res.ok && alive) setData(await res.json());
            } catch { /* leave the last answer */ }
        };
        load();
        const t = setInterval(load, 30000);
        return () => { alive = false; clearInterval(t); };
    }, []);

    if (!data?.shared) return null;
    const others = data.others || [];

    if (!others.length) {
        return (
            <div className="mb-4 flex items-center gap-2 text-sm text-muted">
                <HardDrive size={15} />
                <span>Shared network volume — this Pod ({data.me}) is the only one running on it.</span>
            </div>
        );
    }
    return (
        <div className="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
            <div className="flex items-center gap-2 font-medium text-amber-600 dark:text-amber-400">
                <Users size={15} />
                {others.length} other Pod{others.length > 1 ? 's are' : ' is'} running on this volume
            </div>
            <ul className="mt-1 ml-6 list-disc text-muted">
                {others.map(o => (
                    <li key={o.id}>
                        <span className="font-mono text-foreground">{o.id}</span>
                        {o.serving?.length ? ` — serving ${o.serving.join(', ')}` : ` — ${o.mode || 'starting'}`}
                    </li>
                ))}
            </ul>
            <p className="mt-2 text-muted">
                The models are shared, so pruning and the quarantine are paused until this Pod is alone on the volume.
                Downloads are coordinated: a model another Pod is fetching is waited for, not downloaded twice.
            </p>
        </div>
    );
};

export default VolumePods;
