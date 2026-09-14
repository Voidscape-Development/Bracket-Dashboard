/**
 * What the app is doing, said out loud.
 *
 * Every call to start.gg is slow and invisible, and an import of a large
 * tournament is minutes of silence during which a working app and a wedged one
 * look identical. This is the fix for that: a permanent line in the sidebar
 * naming the current job, which opens into the full list — running work with
 * progress, and recently finished work with its result, including failures,
 * because "why is this bracket empty" is asked after the failure, not during.
 */

import {
  activityPercent,
  summariseActivity,
  type ActivityTask,
} from '@bracket/shared';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { api } from '../api.js';
import { useAppStore } from '../store.js';

export function ActivityIndicator() {
  const activity = useAppStore((s) => s.activity);
  const setActivity = useAppStore((s) => s.setActivity);
  const inFlight = useAppStore((s) => s.status.requestsInFlight);
  const perMinute = useAppStore((s) => s.status.requestsLastMinute);
  const [open, setOpen] = useState(false);

  // The socket pushes every change, but a dashboard opened mid-import would
  // otherwise show nothing until the next one.
  useEffect(() => {
    let cancelled = false;
    api
      .activity()
      .then((result) => {
        if (!cancelled) setActivity(result.activity);
      })
      .catch(() => {
        // The indicator is not worth an error message of its own.
      });
    return () => {
      cancelled = true;
    };
  }, [setActivity]);

  const summary = summariseActivity(activity);
  const busy = activity.running > 0 || inFlight > 0;
  const label = summary ?? (inFlight > 0 ? 'Talking to start.gg…' : 'Idle');
  const barRef = useRef<HTMLButtonElement | null>(null);
  const anchor = useAnchor(barRef, open);

  return (
    <div className="activity">
      <button
        ref={barRef}
        type="button"
        className={`activity__bar ${busy ? 'activity__bar--busy' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title={label}
        aria-expanded={open}
      >
        <span className={`activity__dot ${busy ? 'activity__dot--busy' : ''}`} />
        <span className="activity__label">{label}</span>
        {activity.failed > 0 && <span className="tag tag--warn">{activity.failed}</span>}
        <span className="activity__chevron">{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <ActivityList
          tasks={activity.tasks}
          perMinute={perMinute}
          inFlight={inFlight}
          anchor={anchor}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

/**
 * Where to pin the panel, in viewport coordinates.
 *
 * The sidebar scrolls, and a scroll container clips absolutely-positioned
 * children in both directions — so a panel wider than the sidebar loses its
 * right-hand half. The panel is therefore fixed to the viewport and told where
 * the bar is, which also keeps it out of the way of the footer growing.
 */
function useAnchor(
  ref: React.RefObject<HTMLElement | null>,
  open: boolean,
): { left: number; bottom: number } {
  const [anchor, setAnchor] = useState({ left: 12, bottom: 12 });

  const measure = useCallback(() => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    setAnchor({ left: rect.left, bottom: window.innerHeight - rect.top + 6 });
  }, [ref]);

  useLayoutEffect(() => {
    if (!open) return;
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [open, measure]);

  return anchor;
}

function ActivityList({
  tasks,
  perMinute,
  inFlight,
  anchor,
  onClose,
}: {
  tasks: ActivityTask[];
  perMinute: number;
  inFlight: number;
  anchor: { left: number; bottom: number };
  onClose: () => void;
}) {
  return (
    <div className="activity__panel" style={{ left: anchor.left, bottom: anchor.bottom }}>
      <div className="row row--tight activity__panel-head">
        <strong style={{ fontSize: 13 }}>Activity</strong>
        <span className="spacer" />
        <span className="muted" style={{ fontSize: 11 }}>
          {inFlight} open · {perMinute}/min
        </span>
        <button type="button" className="btn btn--sm btn--ghost" onClick={onClose}>
          Close
        </button>
      </div>

      {tasks.length === 0 ? (
        <p className="muted activity__empty">
          Nothing running. Imports, bracket reads and queued reports show up here
          while they happen.
        </p>
      ) : (
        <TaskList tasks={tasks} />
      )}
    </div>
  );
}

function TaskList({ tasks }: { tasks: ActivityTask[] }) {
  // One clock for the whole list, and only while something is still running.
  const now = useNow(tasks.some((task) => task.status === 'running'));
  return (
    <ul className="activity__items">
      {tasks.map((task) => (
        <ActivityRow key={task.id} task={task} now={now} />
      ))}
    </ul>
  );
}

function ActivityRow({ task, now }: { task: ActivityTask; now: number }) {
  const percent = activityPercent(task);
  return (
    <li className={`activity__item activity__item--${task.status}`}>
      <div className="activity__item-head">
        <span className="activity__item-label">{task.label}</span>
        <span className="activity__item-time">{formatElapsed(task, now)}</span>
      </div>

      {task.status === 'running' && (
        <div className="progress activity__item-progress">
          <div
            className={`progress__fill ${percent === null ? 'progress__fill--pulse' : ''}`}
            style={{ width: percent === null ? '100%' : `${percent}%` }}
          />
        </div>
      )}

      {task.error ? (
        <div className="activity__item-detail activity__item-detail--error">{task.error}</div>
      ) : task.detail ? (
        <div className="activity__item-detail">{task.detail}</div>
      ) : null}
    </li>
  );
}

/** Live seconds while running, then how long it took. */
function formatElapsed(task: ActivityTask, now: number): string {
  const end = task.endedAt ?? now;
  return `${Math.max(0, Math.round((end - task.startedAt) / 1000))}s`;
}

/**
 * A second-resolution clock, so a running task's elapsed time counts up rather
 * than freezing between socket messages. Stops when nothing is running.
 */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}
