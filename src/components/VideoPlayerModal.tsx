import React, { useState, useRef, useEffect, useMemo } from 'react';
import { Video, VideoDetail, QuizQuestion, User } from '../types';
import { Play, CheckCircle2, Lock, X, Maximize2, Minimize2, AlertCircle, HelpCircle, Trophy, History } from 'lucide-react';
import { extractYouTubeVideoId, loadYouTubeIframeApi, type YTPlayer } from '../lib/youtube';
import { WatchSessionTracker } from '../lib/videoTracking';

interface VideoPlayerModalProps {
  video: Video;
  currentUser: User;
  onClose: () => void;
  onProgressUpdate: (videoId: number, percentage: number) => void;
  onQuizComplete: (videoId: number, score: number, passed: boolean) => void;
}

function formatTime(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const mins = Math.floor(s / 60);
  const secs = s % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export const VideoPlayerModal: React.FC<VideoPlayerModalProps> = ({
  video,
  currentUser,
  onClose,
  onProgressUpdate,
  onQuizComplete,
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // The list item passed in only has summary fields — quiz questions, the
  // last saved position, and the completion threshold all come from the
  // authoritative GET /api/videos/:id detail fetch below.
  const [detail, setDetail] = useState<VideoDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [resumeBanner, setResumeBanner] = useState<number | null>(null);

  const [percentage, setPercentage] = useState(video.percentage || 0);
  const [watchedFinished, setWatchedFinished] = useState(video.watchedFinished || false);
  const quizStartedAtRef = useRef<string | null>(null);

  const percentageRef = useRef(percentage);
  useEffect(() => {
    percentageRef.current = percentage;
  }, [percentage]);
  const watchedFinishedRef = useRef(watchedFinished);
  useEffect(() => {
    watchedFinishedRef.current = watchedFinished;
  }, [watchedFinished]);

  const thresholdRef = useRef(0.95);
  const lastPolledPositionRef = useRef(0);
  const trackerRef = useRef<WatchSessionTracker | null>(null);

  const youtubeId = useMemo(() => extractYouTubeVideoId(video.url), [video.url]);
  const youtubeContainerRef = useRef<HTMLDivElement | null>(null);
  const youtubePlayerRef = useRef<YTPlayer | null>(null);
  const youtubeIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Quiz state
  const [showQuiz, setShowQuiz] = useState(false);
  const [selectedAnswers, setSelectedAnswers] = useState<number[]>([]);
  const [quizResult, setQuizResult] = useState<{
    score: number;
    passed: boolean;
    message: string;
  } | null>(null);
  const [submittingQuiz, setSubmittingQuiz] = useState(false);
  const [quizError, setQuizError] = useState<string | null>(null);

  const questions: QuizQuestion[] = detail?.quizQuestions || [];

  // Load the authoritative video detail (quiz questions, resume position,
  // completion threshold) once when the modal opens, and open the tracking
  // session for "video page opened" the moment we know where to resume from.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch(`/api/videos/${video.id}`, { credentials: 'include' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to load this training video.');
        if (cancelled) return;

        setDetail(data);
        setPercentage(data.progress?.percentage || 0);
        setWatchedFinished(data.progress?.watchedFinished || false);
        thresholdRef.current = data.completionThreshold || 0.95;
        setSelectedAnswers(new Array(data.quizQuestions?.length || 0).fill(-1));
        if (data.lastPositionSeconds > 5 && !data.progress?.watchedFinished) {
          setResumeBanner(data.lastPositionSeconds);
        }

        trackerRef.current = new WatchSessionTracker({
          videoId: video.id,
          getPosition: () => lastPolledPositionRef.current,
          getDuration: () => youtubePlayerRef.current?.getDuration() || videoRef.current?.duration || data.durationSeconds || 0,
        });
        await trackerRef.current.open(data.lastPositionSeconds || 0);
      } catch (err: any) {
        if (!cancelled) setDetailError(err.message || 'Failed to load this training video.');
      }
    })();

    return () => {
      cancelled = true;
      trackerRef.current?.close('component_unmount');
      trackerRef.current = null;
    };
  }, [video.id]);

  const handleTimeUpdate = () => {
    if (videoRef.current && videoRef.current.duration) {
      lastPolledPositionRef.current = videoRef.current.currentTime;
      const currentPct = Math.round((videoRef.current.currentTime / videoRef.current.duration) * 100);
      if (currentPct > percentage) {
        setPercentage(currentPct);
        onProgressUpdate(video.id, currentPct);
      }
      if (currentPct / 100 >= thresholdRef.current && !watchedFinished) {
        setWatchedFinished(true);
        onProgressUpdate(video.id, 100);
      }
    }
  };

  const handleEnded = () => {
    setPercentage(100);
    setWatchedFinished(true);
    onProgressUpdate(video.id, 100);
    trackerRef.current?.notifyEnded();
  };

  // Native <video> fallback tracking hooks.
  const handleNativePlay = () => trackerRef.current?.notifyPlaying();
  const handleNativePause = () => trackerRef.current?.notifyPaused();
  const handleNativeSeeking = () => trackerRef.current?.notifySeek();

  // YouTube playback + progress/session tracking. Re-runs when the quiz view
  // mounts over the player (that unmounts the container div) and again when
  // the learner comes back to the video.
  useEffect(() => {
    if (!youtubeId || showQuiz || !youtubeContainerRef.current || !detail) return;

    let cancelled = false;
    let lastKnownTime = 0;

    loadYouTubeIframeApi().then((YT) => {
      if (cancelled || !youtubeContainerRef.current) return;

      youtubePlayerRef.current = new YT.Player(youtubeContainerRef.current, {
        videoId: youtubeId,
        width: '100%',
        height: '100%',
        playerVars: { rel: 0, modestbranding: 1 },
        events: {
          onReady: () => {
            const resumeAt = detail.lastPositionSeconds || 0;
            if (resumeAt > 5) {
              youtubePlayerRef.current?.seekTo(resumeAt, true);
              lastKnownTime = resumeAt;
              lastPolledPositionRef.current = resumeAt;
            }
          },
          onStateChange: (event) => {
            if (event.data === YT.PlayerState.PLAYING) {
              trackerRef.current?.notifyPlaying();
            } else if (event.data === YT.PlayerState.PAUSED || event.data === YT.PlayerState.BUFFERING) {
              trackerRef.current?.notifyPaused();
            } else if (event.data === YT.PlayerState.ENDED) {
              percentageRef.current = 100;
              watchedFinishedRef.current = true;
              setPercentage(100);
              setWatchedFinished(true);
              onProgressUpdate(video.id, 100);
              trackerRef.current?.notifyEnded();
            }
          },
        },
      });

      youtubeIntervalRef.current = setInterval(() => {
        const player = youtubePlayerRef.current;
        if (!player) return;
        const duration = player.getDuration();
        if (!duration) return;

        const currentTime = player.getCurrentTime();
        lastPolledPositionRef.current = currentTime;

        // A jump bigger than a normal 1s poll tick (with slack) means the
        // learner scrubbed the playhead — that skipped range must never
        // count as watched time.
        const state = player.getPlayerState();
        if (state === YT.PlayerState.PLAYING && Math.abs(currentTime - lastKnownTime - 1) > 2) {
          trackerRef.current?.notifySeek();
        }
        lastKnownTime = currentTime;

        const currentPct = Math.round((currentTime / duration) * 100);
        if (currentPct > percentageRef.current) {
          percentageRef.current = currentPct;
          setPercentage(currentPct);
          onProgressUpdate(video.id, currentPct);
        }
        if (currentPct / 100 >= thresholdRef.current && !watchedFinishedRef.current) {
          watchedFinishedRef.current = true;
          setWatchedFinished(true);
          onProgressUpdate(video.id, 100);
        }
      }, 1000);
    });

    return () => {
      cancelled = true;
      if (youtubeIntervalRef.current) clearInterval(youtubeIntervalRef.current);
      youtubePlayerRef.current?.destroy();
      youtubePlayerRef.current = null;
    };
  }, [youtubeId, showQuiz, video.id, detail]);

  const toggleFullscreen = () => {
    setIsFullscreen(!isFullscreen);
  };

  const handleSelectOption = (qIdx: number, optIdx: number) => {
    const updated = [...selectedAnswers];
    updated[qIdx] = optIdx;
    setSelectedAnswers(updated);
  };

  const handleOpenQuiz = () => {
    quizStartedAtRef.current = new Date().toISOString();
    setShowQuiz(true);
  };

  const handleSubmitQuiz = async () => {
    if (selectedAnswers.length === 0 || selectedAnswers.some((a) => a === -1)) {
      setQuizError(`Please answer all ${questions.length} question${questions.length === 1 ? '' : 's'} before submitting!`);
      return;
    }
    setQuizError(null);
    setSubmittingQuiz(true);

    try {
      const res = await fetch('/api/progress/quiz', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          videoId: video.id,
          answers: selectedAnswers,
          startedAt: quizStartedAtRef.current,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to submit quiz');
      }

      setQuizResult(data);
      onQuizComplete(video.id, data.score, data.passed);
    } catch (err: any) {
      setQuizError(err.message || 'Error processing quiz');
    } finally {
      setSubmittingQuiz(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md flex items-center justify-center p-2 sm:p-4 z-50 overflow-y-auto">
      <div
        className={`bg-white rounded-[24px] sm:rounded-[32px] w-full shadow-2xl border border-slate-200 overflow-hidden flex flex-col transition-all ${
          isFullscreen ? 'max-w-6xl h-[90vh]' : 'max-w-4xl max-h-[90vh]'
        }`}
      >
        {/* Modal Top Header */}
        <div className="bg-slate-900 px-4 sm:px-6 py-3 sm:py-4 flex items-center justify-between border-b border-slate-800 text-white shrink-0">
          <div className="flex items-center gap-2 sm:gap-3 overflow-hidden">
            <span className="hidden sm:inline-block px-3 py-1 bg-indigo-500/20 text-indigo-300 rounded-full text-xs font-bold uppercase tracking-wider border border-indigo-500/30 shrink-0">
              Training Module
            </span>
            <h3 className="text-sm sm:text-lg font-bold truncate max-w-[160px] sm:max-w-md">{video.title}</h3>
          </div>

          <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
            <button
              onClick={toggleFullscreen}
              className="p-1.5 sm:p-2 text-slate-400 hover:text-white hover:bg-slate-800 rounded-xl transition-colors"
              title={isFullscreen ? 'Moderate Size' : 'Full Screen'}
            >
              {isFullscreen ? <Minimize2 className="w-4 h-4 sm:w-5 sm:h-5" /> : <Maximize2 className="w-4 h-4 sm:w-5 sm:h-5" />}
            </button>
            <button
              onClick={onClose}
              className="p-1.5 sm:p-2 text-slate-400 hover:text-white hover:bg-slate-800 rounded-xl transition-colors"
            >
              <X className="w-4 h-4 sm:w-5 sm:h-5" />
            </button>
          </div>
        </div>

        {/* Modal Body */}
        <div className="p-4 sm:p-6 overflow-y-auto flex-1 space-y-4 sm:space-y-6">
          {detailError && (
            <div className="p-4 bg-rose-50 border border-rose-200 rounded-2xl text-rose-700 text-xs font-medium flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" /> {detailError}
            </div>
          )}

          {!showQuiz ? (
            /* VIDEO WATCHER VIEW */
            <>
              {resumeBanner !== null && (
                <div className="p-3 bg-indigo-50 border border-indigo-200 rounded-2xl text-indigo-700 text-xs font-semibold flex items-center gap-2">
                  <History className="w-4 h-4 shrink-0" />
                  Resumed from {formatTime(resumeBanner)}
                </div>
              )}

              {/* Video Player: YouTube embed when the stored URL is a YouTube link, native HTML5 player otherwise */}
              <div className="relative bg-slate-950 rounded-2xl overflow-hidden aspect-video shadow-xl border border-slate-800 flex items-center justify-center group">
                {youtubeId ? (
                  <div ref={youtubeContainerRef} className="w-full h-full" />
                ) : (
                  <video
                    ref={videoRef}
                    src={video.url}
                    controls
                    onTimeUpdate={handleTimeUpdate}
                    onEnded={handleEnded}
                    onPlay={handleNativePlay}
                    onPause={handleNativePause}
                    onSeeking={handleNativeSeeking}
                    className="w-full h-full object-cover"
                  />
                )}
              </div>

              {/* Progress Tracking Bar */}
              <div className="bg-slate-50 p-5 rounded-2xl border border-slate-200 space-y-3">
                <div className="flex items-center justify-between text-xs font-bold text-slate-700">
                  <span>Watched Progress</span>
                  <span className="text-indigo-600 font-mono text-sm">{percentage}% FINISHED</span>
                </div>
                <div className="w-full h-3 bg-slate-200 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-r from-indigo-500 to-indigo-600 rounded-full transition-all duration-300"
                    style={{ width: `${percentage}%` }}
                  ></div>
                </div>
                <p className="text-xs text-slate-500">
                  {watchedFinished
                    ? questions.length > 0
                      ? 'Video fully watched! You are ready to complete the quiz below.'
                      : 'Video fully watched! This module is complete.'
                    : questions.length > 0
                      ? 'Watch the entire video to unlock the quiz.'
                      : 'Watch the entire video to complete this module.'}
                </p>
                <p className="text-[10px] text-slate-400">
                  Training activity is recorded for completion and compliance reporting.
                </p>
              </div>

              {/* Video Description & Quiz Launch */}
              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 pt-2 border-t border-slate-100">
                <div>
                  <h4 className="font-bold text-slate-900 text-lg">{video.title}</h4>
                  <p className="text-sm text-slate-500 mt-1 max-w-xl">
                    {video.description || 'Watch carefully before attempting the quiz.'}
                  </p>
                </div>

                <div className="shrink-0">
                  {watchedFinished ? (
                    questions.length > 0 ? (
                      <button
                        onClick={handleOpenQuiz}
                        className="px-6 py-3 bg-indigo-600 hover:bg-indigo-700 text-white rounded-2xl font-bold text-sm shadow-xl shadow-indigo-200 transition-all flex items-center gap-2 animate-bounce"
                      >
                        <HelpCircle className="w-5 h-5" />
                        Take Quiz ({questions.length} Question{questions.length === 1 ? '' : 's'})
                      </button>
                    ) : (
                      <div className="px-5 py-3 bg-emerald-50 border border-emerald-200 text-emerald-700 rounded-2xl text-xs font-bold flex items-center gap-2">
                        <CheckCircle2 className="w-4 h-4" />
                        No quiz for this video
                      </div>
                    )
                  ) : (
                    <div className="px-5 py-3 bg-slate-100 border border-slate-200 text-slate-400 rounded-2xl text-xs font-bold flex items-center gap-2">
                      <Lock className="w-4 h-4" />
                      Finish Video to Unlock Quiz
                    </div>
                  )}
                </div>
              </div>
            </>
          ) : (
            /* QUIZ EVALUATION VIEW */
            <div className="space-y-6">
              <div className="flex items-center justify-between pb-4 border-b border-slate-100">
                <div>
                  <h3 className="text-xl font-bold text-slate-900">Module Knowledge Check</h3>
                  <p className="text-xs text-slate-500 mt-1">
                    Answer all {questions.length} question{questions.length === 1 ? '' : 's'}. At least{' '}
                    <strong className="text-indigo-600">2 out of 3 (66%)</strong> score is required to pass and move
                    to the next video.
                  </p>
                </div>
                <button
                  onClick={() => setShowQuiz(false)}
                  className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl text-xs font-bold"
                >
                  Back to Video
                </button>
              </div>

              {quizError && (
                <div className="p-4 bg-rose-50 border border-rose-200 rounded-2xl text-rose-700 text-xs font-medium flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 text-rose-600" />
                  <span>{quizError}</span>
                </div>
              )}

              {!quizResult ? (
                /* QUIZ QUESTION FORM */
                <div className="space-y-6">
                  {questions.map((q, qIdx) => (
                    <div key={q.id || qIdx} className="p-5 bg-slate-50 rounded-2xl border border-slate-200 space-y-3">
                      <p className="font-bold text-slate-800 text-sm flex items-start gap-2">
                        <span className="w-6 h-6 rounded-lg bg-indigo-600 text-white flex items-center justify-center text-xs shrink-0 font-mono">
                          {qIdx + 1}
                        </span>
                        <span>{q.question}</span>
                      </p>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-2">
                        {q.options.map((opt, optIdx) => {
                          const isSelected = selectedAnswers[qIdx] === optIdx;
                          return (
                            <button
                              key={optIdx}
                              type="button"
                              onClick={() => handleSelectOption(qIdx, optIdx)}
                              className={`p-3.5 rounded-xl text-xs text-left font-medium transition-all border ${
                                isSelected
                                  ? 'bg-indigo-600 text-white border-indigo-600 font-semibold shadow-md shadow-indigo-100'
                                  : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-100'
                              }`}
                            >
                              <span className="font-bold mr-2 uppercase">{String.fromCharCode(65 + optIdx)}.</span>
                              {opt}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}

                  <button
                    onClick={handleSubmitQuiz}
                    disabled={submittingQuiz}
                    className="w-full py-4 bg-indigo-600 hover:bg-indigo-700 text-white rounded-2xl font-bold text-sm shadow-xl shadow-indigo-200 transition-all flex items-center justify-center gap-2"
                  >
                    {submittingQuiz ? 'Evaluating Answers...' : 'Submit Quiz & Check Score'}
                  </button>
                </div>
              ) : (
                /* QUIZ RESULT FEEDBACK */
                <div className="p-8 text-center bg-slate-50 rounded-3xl border border-slate-200 space-y-6">
                  <div className="inline-flex p-4 rounded-3xl bg-indigo-100 text-indigo-600 shadow-lg shadow-indigo-100">
                    <Trophy className="w-12 h-12" />
                  </div>

                  <div>
                    <h3 className="text-2xl font-extrabold text-slate-900">
                      {quizResult.passed ? 'Quiz Passed!' : 'Did Not Pass'}
                    </h3>
                    <p className="text-sm font-semibold text-slate-600 mt-2">
                      Your Score: <span className="text-indigo-600 font-mono text-lg font-bold">{quizResult.score} / {questions.length}</span>
                    </p>
                    <p className="text-xs text-slate-500 mt-2 max-w-md mx-auto">
                      {quizResult.message}
                    </p>
                  </div>

                  <div className="flex gap-3 justify-center pt-4">
                    {!quizResult.passed ? (
                      <button
                        onClick={() => {
                          setQuizResult(null);
                          setSelectedAnswers(new Array(questions.length).fill(-1));
                          quizStartedAtRef.current = new Date().toISOString();
                        }}
                        className="px-6 py-3 bg-indigo-600 text-white rounded-2xl font-bold text-xs shadow-lg shadow-indigo-200"
                      >
                        Try Quiz Again
                      </button>
                    ) : (
                      <button
                        onClick={onClose}
                        className="px-8 py-3 bg-emerald-600 text-white rounded-2xl font-bold text-xs shadow-lg shadow-emerald-200"
                      >
                        Proceed to Next Module
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
