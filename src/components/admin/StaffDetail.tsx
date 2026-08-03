import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  ShieldCheck,
  Mail,
  Calendar,
  Clock,
  History,
  CheckCircle2,
  XCircle,
  Trash2,
  X,
} from 'lucide-react';
import {
  StaffDetailHeader,
  CourseAssignment,
  StaffVideoActivity,
  QuizAttemptRecord,
  CompletionHistoryRecord,
  TimelinePage,
  VideoWatchSession,
} from '../../types';
import { ConfirmDialog } from '../ConfirmDialog';

interface StaffDetailProps {
  staffId: number;
  onBack: () => void;
}

type Tab = 'overview' | 'assignments' | 'video' | 'quiz' | 'completions' | 'timeline';

function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m.toString().padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${sec.toString().padStart(2, '0')}s`;
  return `${sec}s`;
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

async function fetchJson(url: string) {
  const res = await fetch(url, { credentials: 'include' });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const message = typeof json?.error === 'string' ? json.error : json?.error?.message;
    throw new Error(message || `Request failed (${res.status})`);
  }
  return json;
}

export const StaffDetail: React.FC<StaffDetailProps> = ({ staffId, onBack }) => {
  const [header, setHeader] = useState<StaffDetailHeader | null>(null);
  const [assignments, setAssignments] = useState<CourseAssignment[]>([]);
  const [videoActivity, setVideoActivity] = useState<StaffVideoActivity[]>([]);
  const [quizAttempts, setQuizAttempts] = useState<QuizAttemptRecord[]>([]);
  const [completions, setCompletions] = useState<CompletionHistoryRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [tab, setTab] = useState<Tab>('overview');

  const [timeline, setTimeline] = useState<TimelinePage | null>(null);
  const [timelinePage, setTimelinePage] = useState(1);
  const [timelineLoading, setTimelineLoading] = useState(false);

  const [sessionModalVideo, setSessionModalVideo] = useState<StaffVideoActivity | null>(null);
  const [sessions, setSessions] = useState<VideoWatchSession[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);

  const [assignmentToRemove, setAssignmentToRemove] = useState<CourseAssignment | null>(null);
  const [removingAssignment, setRemovingAssignment] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const [h, a, v, q, c] = await Promise.all([
          fetchJson(`/api/admin/staff/${staffId}`),
          fetchJson(`/api/admin/staff/${staffId}/assignments`),
          fetchJson(`/api/admin/staff/${staffId}/video-activity`),
          fetchJson(`/api/admin/staff/${staffId}/quiz-attempts`),
          fetchJson(`/api/admin/staff/${staffId}/completion-history`),
        ]);
        if (cancelled) return;
        setHeader(h);
        setAssignments(a);
        setVideoActivity(v);
        setQuizAttempts(q);
        setCompletions(c);
      } catch (err: any) {
        if (!cancelled) setError(err.message || 'Failed to load staff detail.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [staffId]);

  useEffect(() => {
    if (tab !== 'timeline') return;
    let cancelled = false;
    setTimelineLoading(true);
    fetchJson(`/api/admin/staff/${staffId}/timeline?page=${timelinePage}&pageSize=20`)
      .then((json) => {
        if (!cancelled) setTimeline(json);
      })
      .catch(() => {
        if (!cancelled) setTimeline({ events: [], page: 1, pageSize: 20, totalCount: 0, totalPages: 1 });
      })
      .finally(() => {
        if (!cancelled) setTimelineLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tab, staffId, timelinePage]);

  const openSessions = async (v: StaffVideoActivity) => {
    setSessionModalVideo(v);
    setSessionsLoading(true);
    try {
      const json = await fetchJson(`/api/admin/staff/${staffId}/video-activity/${v.videoId}/sessions`);
      setSessions(json);
    } catch {
      setSessions([]);
    } finally {
      setSessionsLoading(false);
    }
  };

  const executeRemoveAssignment = async () => {
    if (!assignmentToRemove) return;
    setRemovingAssignment(true);
    try {
      const res = await fetch(`/api/admin/assignments/${assignmentToRemove.id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (res.ok) {
        setAssignments((prev) => prev.filter((a) => a.id !== assignmentToRemove.id));
      }
    } finally {
      setAssignmentToRemove(null);
      setRemovingAssignment(false);
    }
  };

  const summary = useMemo(() => {
    const completedCourses = assignments.filter((a) => a.status === 'completed').length;
    const inProgressCourses = assignments.filter((a) => a.status === 'in_progress').length;
    const notStartedCourses = assignments.filter((a) => a.status === 'not_started').length;
    const completedVideos = videoActivity.filter((v) => v.completed).length;
    const outstandingVideos = videoActivity.filter((v) => !v.completed).length;
    const totalActiveWatchSeconds = videoActivity.reduce((sum, v) => sum + v.totalActiveWatchSeconds, 0);
    const passedQuizzes = quizAttempts.filter((q) => q.passed).length;
    const failedQuizzes = quizAttempts.filter((q) => !q.passed).length;
    const avgQuizScore =
      quizAttempts.length > 0 ? Math.round(quizAttempts.reduce((s, q) => s + q.percentage, 0) / quizAttempts.length) : null;

    return {
      assignedCourses: assignments.length,
      completedCourses,
      inProgressCourses,
      notStartedCourses,
      completedVideos,
      outstandingVideos,
      totalActiveWatchSeconds,
      avgQuizScore,
      passedQuizzes,
      failedQuizzes,
    };
  }, [assignments, videoActivity, quizAttempts]);

  if (loading) return <div className="text-sm text-slate-500 p-8 text-center">Loading staff detail…</div>;
  if (error || !header)
    return <div className="p-6 bg-rose-50 border border-rose-200 rounded-2xl text-rose-700 text-sm">{error || 'Staff member not found.'}</div>;

  const tabs: { key: Tab; label: string }[] = [
    { key: 'overview', label: 'Overview' },
    { key: 'assignments', label: 'Assigned Training' },
    { key: 'video', label: 'Video Activity' },
    { key: 'quiz', label: 'Quiz Attempts' },
    { key: 'completions', label: 'Completion History' },
    { key: 'timeline', label: 'Activity Timeline' },
  ];

  return (
    <div className="space-y-6 select-none">
      <button onClick={onBack} className="flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-slate-800">
        <ArrowLeft className="w-4 h-4" /> Back to Reports
      </button>

      {/* Header */}
      <div className="bg-white rounded-[24px] p-5 sm:p-6 border border-slate-200 shadow-sm">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="w-14 h-14 rounded-2xl bg-indigo-600 text-white flex items-center justify-center font-bold text-lg shrink-0">
              {header.username.substring(0, 2).toUpperCase()}
            </div>
            <div>
              <h2 className="text-xl font-bold text-slate-900">{header.username}</h2>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1 text-xs text-slate-500">
                <span className="flex items-center gap-1">
                  <Mail className="w-3.5 h-3.5" /> {header.email}
                </span>
                <span className="flex items-center gap-1">
                  <ShieldCheck className="w-3.5 h-3.5" /> {header.role}
                </span>
                {header.homeName && <span>{header.homeName}</span>}
              </div>
            </div>
          </div>
          <div className="flex flex-col items-start sm:items-end gap-1 text-xs text-slate-500">
            <span className="flex items-center gap-1.5">
              <Calendar className="w-3.5 h-3.5" /> Joined {formatDate(header.createdAt)}
            </span>
            <span className="flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5" /> Last activity {formatDate(header.lastActivity)}
            </span>
          </div>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-5 gap-3">
        {[
          { label: 'Assigned Courses', value: summary.assignedCourses },
          { label: 'Completed Courses', value: summary.completedCourses },
          { label: 'In Progress', value: summary.inProgressCourses },
          { label: 'Not Started', value: summary.notStartedCourses },
          { label: 'Completed Videos', value: summary.completedVideos },
          { label: 'Outstanding Videos', value: summary.outstandingVideos },
          { label: 'Active Watch Time', value: formatDuration(summary.totalActiveWatchSeconds) },
          { label: 'Avg Quiz Score', value: summary.avgQuizScore === null ? '—' : `${summary.avgQuizScore}%` },
          { label: 'Passed Quizzes', value: summary.passedQuizzes },
          { label: 'Failed Quizzes', value: summary.failedQuizzes },
        ].map((c) => (
          <div key={c.label} className="bg-white rounded-2xl p-3.5 border border-slate-200 shadow-sm">
            <p className="text-lg font-black text-slate-900">{c.value}</p>
            <p className="text-[10px] font-semibold text-slate-500 mt-0.5 uppercase tracking-wide">{c.label}</p>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div className="flex overflow-x-auto bg-white p-1.5 rounded-2xl border border-slate-200 shadow-sm gap-1 scrollbar-none">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-3.5 py-2 rounded-xl text-xs font-bold transition-all shrink-0 ${
              tab === t.key ? 'bg-indigo-600 text-white shadow-md' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <div className="bg-white rounded-[24px] p-5 sm:p-6 border border-slate-200 shadow-sm space-y-4">
          <h3 className="font-bold text-slate-900 text-sm">Overview</h3>
          <p className="text-xs text-slate-500">
            {header.username} has {summary.assignedCourses} assigned course{summary.assignedCourses === 1 ? '' : 's'},{' '}
            {summary.completedVideos} completed video{summary.completedVideos === 1 ? '' : 's'}, and{' '}
            {quizAttempts.length} quiz attempt{quizAttempts.length === 1 ? '' : 's'}
            {summary.avgQuizScore !== null ? ` averaging ${summary.avgQuizScore}%` : ''}.
          </p>
          {summary.assignedCourses === 0 && (
            <div className="p-4 bg-slate-50 rounded-2xl text-center text-xs text-slate-500">
              No training has been assigned to this staff member yet.
            </div>
          )}
        </div>
      )}

      {tab === 'assignments' && (
        <div className="bg-white rounded-[24px] border border-slate-200 shadow-sm overflow-hidden">
          {assignments.length === 0 ? (
            <p className="text-xs text-slate-400 py-10 text-center">No courses assigned.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200 text-left text-[11px] uppercase font-bold text-slate-500">
                    <th className="px-4 py-3">Course</th>
                    <th className="px-4 py-3">Assigned</th>
                    <th className="px-4 py-3">By</th>
                    <th className="px-4 py-3">Required</th>
                    <th className="px-4 py-3">Due</th>
                    <th className="px-4 py-3">Progress</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Last Activity</th>
                    <th className="px-4 py-3"></th>
                  </tr>
                </thead>
                <tbody>
                  {assignments.map((a) => (
                    <tr key={a.id} className="border-b border-slate-100 last:border-0">
                      <td className="px-4 py-3 font-bold text-slate-800 text-xs">{a.sectionTitle}</td>
                      <td className="px-4 py-3 text-xs text-slate-500">{formatDate(a.assignedAt)}</td>
                      <td className="px-4 py-3 text-xs text-slate-500">{a.assignedByName || '—'}</td>
                      <td className="px-4 py-3 text-xs">{a.required ? 'Required' : 'Optional'}</td>
                      <td className="px-4 py-3 text-xs text-slate-500">{a.dueDate ? new Date(a.dueDate).toLocaleDateString() : '—'}</td>
                      <td className="px-4 py-3 text-xs text-slate-600">
                        {a.completedVideos}/{a.totalVideos} ({a.completionPercentage}%)
                      </td>
                      <td className="px-4 py-3 text-xs capitalize">{a.status.replace('_', ' ')}</td>
                      <td className="px-4 py-3 text-xs text-slate-500">{formatDate(a.lastActivity)}</td>
                      <td className="px-4 py-3">
                        <button
                          onClick={() => setAssignmentToRemove(a)}
                          className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-colors"
                          title="Unassign"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {tab === 'video' && (
        <div className="bg-white rounded-[24px] border border-slate-200 shadow-sm overflow-hidden">
          {videoActivity.length === 0 ? (
            <p className="text-xs text-slate-400 py-10 text-center">No video activity recorded yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200 text-left text-[11px] uppercase font-bold text-slate-500">
                    <th className="px-4 py-3">Video</th>
                    <th className="px-4 py-3">Course</th>
                    <th className="px-4 py-3">First / Last Opened</th>
                    <th className="px-4 py-3">Sessions</th>
                    <th className="px-4 py-3">Active Watch Time</th>
                    <th className="px-4 py-3">Last Position</th>
                    <th className="px-4 py-3">Watched %</th>
                    <th className="px-4 py-3">Completed</th>
                    <th className="px-4 py-3"></th>
                  </tr>
                </thead>
                <tbody>
                  {videoActivity.map((v) => (
                    <tr key={v.videoId} className="border-b border-slate-100 last:border-0">
                      <td className="px-4 py-3 font-bold text-slate-800 text-xs">{v.videoTitle}</td>
                      <td className="px-4 py-3 text-xs text-slate-500">{v.sectionTitle}</td>
                      <td className="px-4 py-3 text-xs text-slate-500">
                        {formatDate(v.firstOpened)}
                        <br />
                        {formatDate(v.lastOpened)}
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-600">{v.numberOfSessions}</td>
                      <td className="px-4 py-3 text-xs text-slate-600">{formatDuration(v.totalActiveWatchSeconds)}</td>
                      <td className="px-4 py-3 text-xs text-slate-600">
                        {formatDuration(v.lastPositionSeconds)}
                        {v.videoDurationSeconds ? ` / ${formatDuration(v.videoDurationSeconds)}` : ''}
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-600">{v.watchedPercentage}%</td>
                      <td className="px-4 py-3">
                        {v.completed ? (
                          <span className="flex items-center gap-1 text-emerald-600 text-xs font-bold">
                            <CheckCircle2 className="w-3.5 h-3.5" /> Yes
                          </span>
                        ) : (
                          <span className="flex items-center gap-1 text-slate-400 text-xs font-bold">
                            <XCircle className="w-3.5 h-3.5" /> No
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <button
                          onClick={() => openSessions(v)}
                          className="text-[11px] font-bold text-indigo-600 hover:underline flex items-center gap-1"
                        >
                          <History className="w-3.5 h-3.5" /> Sessions
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {tab === 'quiz' && (
        <div className="bg-white rounded-[24px] border border-slate-200 shadow-sm overflow-hidden">
          {quizAttempts.length === 0 ? (
            <p className="text-xs text-slate-400 py-10 text-center">No quiz attempts yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200 text-left text-[11px] uppercase font-bold text-slate-500">
                    <th className="px-4 py-3">Video</th>
                    <th className="px-4 py-3">Course</th>
                    <th className="px-4 py-3">Attempt #</th>
                    <th className="px-4 py-3">Started</th>
                    <th className="px-4 py-3">Submitted</th>
                    <th className="px-4 py-3">Score</th>
                    <th className="px-4 py-3">Result</th>
                    <th className="px-4 py-3">Time Spent</th>
                  </tr>
                </thead>
                <tbody>
                  {quizAttempts.map((q) => (
                    <tr key={q.id} className="border-b border-slate-100 last:border-0">
                      <td className="px-4 py-3 font-bold text-slate-800 text-xs">{q.videoTitle}</td>
                      <td className="px-4 py-3 text-xs text-slate-500">{q.sectionTitle}</td>
                      <td className="px-4 py-3 text-xs text-slate-600">#{q.attemptNumber}</td>
                      <td className="px-4 py-3 text-xs text-slate-500">{formatDate(q.startedAt)}</td>
                      <td className="px-4 py-3 text-xs text-slate-500">{formatDate(q.submittedAt)}</td>
                      <td className="px-4 py-3 text-xs text-slate-600">
                        {q.score}/{q.maximumScore} ({q.percentage}%)
                      </td>
                      <td className="px-4 py-3">
                        {q.passed ? (
                          <span className="flex items-center gap-1 text-emerald-600 text-xs font-bold">
                            <CheckCircle2 className="w-3.5 h-3.5" /> Passed
                          </span>
                        ) : (
                          <span className="flex items-center gap-1 text-rose-600 text-xs font-bold">
                            <XCircle className="w-3.5 h-3.5" /> Failed
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-500">
                        {q.timeSpentSeconds !== null ? formatDuration(q.timeSpentSeconds) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {tab === 'completions' && (
        <div className="bg-white rounded-[24px] border border-slate-200 shadow-sm overflow-hidden">
          {completions.length === 0 ? (
            <p className="text-xs text-slate-400 py-10 text-center">No completions recorded yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200 text-left text-[11px] uppercase font-bold text-slate-500">
                    <th className="px-4 py-3">Course</th>
                    <th className="px-4 py-3">Video</th>
                    <th className="px-4 py-3">Completed</th>
                    <th className="px-4 py-3">Watched %</th>
                    <th className="px-4 py-3">Quiz Score</th>
                  </tr>
                </thead>
                <tbody>
                  {completions.map((c, idx) => (
                    <tr key={`${c.videoId}-${idx}`} className="border-b border-slate-100 last:border-0">
                      <td className="px-4 py-3 text-xs text-slate-500">{c.sectionTitle}</td>
                      <td className="px-4 py-3 font-bold text-slate-800 text-xs">{c.videoTitle}</td>
                      <td className="px-4 py-3 text-xs text-slate-500">{formatDate(c.updatedAt)}</td>
                      <td className="px-4 py-3 text-xs text-slate-600">{c.percentage}%</td>
                      <td className="px-4 py-3 text-xs text-slate-600">{c.quizScore}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {tab === 'timeline' && (
        <div className="bg-white rounded-[24px] p-5 border border-slate-200 shadow-sm space-y-3">
          {timelineLoading ? (
            <p className="text-xs text-slate-400 py-10 text-center">Loading timeline…</p>
          ) : !timeline || timeline.events.length === 0 ? (
            <p className="text-xs text-slate-400 py-10 text-center">No activity recorded yet.</p>
          ) : (
            <>
              <div className="space-y-2">
                {timeline.events.map((e, idx) => (
                  <div key={idx} className="flex items-start gap-3 p-2.5 rounded-xl hover:bg-slate-50">
                    <div className="w-2 h-2 rounded-full bg-indigo-500 mt-1.5 shrink-0" />
                    <div className="flex-1">
                      <p className="text-xs text-slate-700">{e.description}</p>
                      <p className="text-[11px] text-slate-400">{formatDate(e.timestamp)}</p>
                    </div>
                  </div>
                ))}
              </div>
              <div className="flex items-center justify-between pt-2 border-t border-slate-100">
                <button
                  disabled={timelinePage <= 1}
                  onClick={() => setTimelinePage((p) => Math.max(1, p - 1))}
                  className="text-xs font-bold text-slate-500 disabled:opacity-30"
                >
                  Previous
                </button>
                <span className="text-[11px] text-slate-400">
                  Page {timeline.page} of {timeline.totalPages || 1}
                </span>
                <button
                  disabled={timelinePage >= (timeline.totalPages || 1)}
                  onClick={() => setTimelinePage((p) => p + 1)}
                  className="text-xs font-bold text-slate-500 disabled:opacity-30"
                >
                  Next
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* Session history modal */}
      {sessionModalVideo && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-[28px] max-w-2xl w-full p-6 shadow-2xl space-y-4 border border-slate-100 max-h-[85vh] overflow-y-auto">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-lg font-bold text-slate-900">Session History</h3>
                <p className="text-xs text-slate-500">{sessionModalVideo.videoTitle}</p>
              </div>
              <button
                onClick={() => setSessionModalVideo(null)}
                className="p-2 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-xl"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {sessionsLoading ? (
              <p className="text-xs text-slate-400 py-8 text-center">Loading sessions…</p>
            ) : sessions.length === 0 ? (
              <p className="text-xs text-slate-400 py-8 text-center">No sessions recorded.</p>
            ) : (
              <div className="space-y-2">
                {sessions.map((s, idx) => (
                  <div key={s.id} className="p-3 bg-slate-50 rounded-xl border border-slate-100 text-xs space-y-1">
                    <p className="font-bold text-slate-800">Session #{idx + 1}</p>
                    <p className="text-slate-500">Opened: {formatDate(s.openedAt)}</p>
                    <p className="text-slate-500">First played: {formatDate(s.firstPlayedAt)}</p>
                    <p className="text-slate-500">Closed / last activity: {formatDate(s.closedAt || s.lastActivityAt)}</p>
                    <p className="text-slate-500">
                      Active watch time: {formatDuration(s.activeWatchSeconds)} • Start position:{' '}
                      {formatDuration(s.startPositionSeconds)} • Final position: {formatDuration(s.lastPositionSeconds)}
                    </p>
                    <p className="text-slate-500">
                      Exit reason: {s.exitReason || '—'} • Completed this session: {s.completed ? 'Yes' : 'No'}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {assignmentToRemove && (
        <ConfirmDialog
          title="Unassign course?"
          description={`Remove "${assignmentToRemove.sectionTitle}" from ${header.username}? They will lose access to it immediately.`}
          confirmLabel="Unassign"
          loadingLabel="Removing..."
          isLoading={removingAssignment}
          onConfirm={executeRemoveAssignment}
          onCancel={() => setAssignmentToRemove(null)}
        />
      )}
    </div>
  );
};
