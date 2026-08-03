import express from 'express';
import * as dotenv from 'dotenv';
import { db, checkDatabaseConnection } from '../db/index.js';
import {
  homes,
  users,
  sections,
  videos,
  quizQuestions,
  userProgress,
  courseAssignments,
  videoWatchSessions,
  quizAttempts,
} from '../db/schema.js';
import { eq, and, sql, asc, desc, inArray } from 'drizzle-orm';
import { requireAuth, requireAdmin, AuthRequest } from '../middleware/auth.js';
import {
  createSessionToken,
  getSessionCookieOptions,
  SESSION_COOKIE_NAME,
  createPasswordChangeToken,
  verifyPasswordChangeToken,
} from '../lib/session.js';
import { hashPassword, verifyPassword, DUMMY_PASSWORD_HASH } from '../lib/password.js';
import { sendOtpEmail, EmailNotConfiguredError } from '../lib/mailer.js';
import { VIDEO_COMPLETION_THRESHOLD, HEARTBEAT_DELTA_MAX_SECONDS } from '../lib/config.js';

dotenv.config({ quiet: true });

// A database connection failure surfaces very differently depending on the
// driver/OS (ECONNREFUSED, ENOTFOUND, auth failures, etc). Centralizing the
// classification keeps every route's catch block honest: log the real error,
// but only ever send the client a safe, generic message.
function isDatabaseConnectivityError(err: any): boolean {
  // Drizzle wraps the underlying pg/network error in its own error with the
  // real one on `.cause` — check both so the classification survives that
  // wrapping instead of silently falling through to a generic 500.
  const code = err?.code || err?.cause?.code;
  return (
    code === 'ECONNREFUSED' ||
    code === 'ENOTFOUND' ||
    code === 'ETIMEDOUT' ||
    code === '28P01' || // invalid password
    code === '3D000' || // database does not exist
    code === '28000' // invalid authorization
  );
}

function sendServerError(res: express.Response, err: any, context: string) {
  const cause = err?.cause;
  console.error(
    `[${context}]`,
    err?.message || err,
    cause ? `| cause: code=${cause.code} message=${cause.message}` : ''
  );
  if (isDatabaseConnectivityError(err)) {
    return res.status(503).json({
      error: {
        code: 'DATABASE_UNAVAILABLE',
        message: 'The service is temporarily unavailable. Please try again shortly.',
      },
    });
  }
  return res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Something went wrong. Please try again or contact an administrator.',
    },
  });
}

// Returns true if any video in this section has staff activity worth
// preserving (progress, watch sessions, quiz attempts) or the section itself
// has assignments — used to decide archive vs hard-delete.
async function videosHaveHistory(videoIds: number[]): Promise<boolean> {
  if (videoIds.length === 0) return false;
  const [p] = await db.select({ id: userProgress.id }).from(userProgress).where(inArray(userProgress.videoId, videoIds)).limit(1);
  if (p) return true;
  const [w] = await db.select({ id: videoWatchSessions.id }).from(videoWatchSessions).where(inArray(videoWatchSessions.videoId, videoIds)).limit(1);
  if (w) return true;
  const [q] = await db.select({ id: quizAttempts.id }).from(quizAttempts).where(inArray(quizAttempts.videoId, videoIds)).limit(1);
  if (q) return true;
  return false;
}

async function sectionHasHistory(sectionId: number): Promise<boolean> {
  const [assignmentRow] = await db
    .select({ id: courseAssignments.id })
    .from(courseAssignments)
    .where(eq(courseAssignments.sectionId, sectionId))
    .limit(1);
  if (assignmentRow) return true;

  const sectionVideos = await db.select({ id: videos.id }).from(videos).where(eq(videos.sectionId, sectionId));
  return videosHaveHistory(sectionVideos.map((v) => v.id));
}

// Recomputes the legacy per-(user,video) userProgress row from the
// authoritative videoWatchSessions rows, so existing "percentage"/
// "watchedFinished" readers (quiz unlock, course cards) stay correct without
// trusting whatever the client last claimed directly.
async function syncUserProgressFromSessions(userId: number, videoId: number) {
  const allSessions = await db
    .select()
    .from(videoWatchSessions)
    .where(and(eq(videoWatchSessions.userId, userId), eq(videoWatchSessions.videoId, videoId)));

  const bestPct = allSessions.reduce((max, s) => Math.max(max, s.completionPercentage), 0);
  const finished = allSessions.some((s) => s.completed);

  // Quizzes are optional per video. A video with no quiz questions has
  // nothing to unlock "passed" via /api/progress/quiz, so finishing the
  // watch is itself the completion signal for that video.
  const [{ count: quizCount }] = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(quizQuestions)
    .where(eq(quizQuestions.videoId, videoId));
  const autoPassed = finished && Number(quizCount) === 0;

  await db
    .insert(userProgress)
    .values({ userId, videoId, percentage: bestPct, watchedFinished: finished, passed: autoPassed })
    .onConflictDoUpdate({
      target: [userProgress.userId, userProgress.videoId],
      set: {
        percentage: sql`GREATEST(${userProgress.percentage}, ${bestPct})`,
        watchedFinished: sql`${userProgress.watchedFinished} OR ${finished}`,
        passed: sql`${userProgress.passed} OR ${autoPassed}`,
        updatedAt: new Date(),
      },
    });
}

// Applies a heartbeat/close update to a watch session: clamps the claimed
// active-time delta to a plausible bound, clamps position to the video's
// duration, and (re)computes completion against VIDEO_COMPLETION_THRESHOLD.
// Never trusts a client-supplied percentage directly.
async function applyWatchSessionUpdate(
  session: typeof videoWatchSessions.$inferSelect,
  opts: {
    activeSecondsDelta?: unknown;
    lastPositionSeconds?: unknown;
    videoDurationSeconds?: unknown;
    firstPlay?: unknown;
    extra?: Partial<typeof videoWatchSessions.$inferInsert>;
  }
) {
  const clampedDelta = Math.max(0, Math.min(Number(opts.activeSecondsDelta) || 0, HEARTBEAT_DELTA_MAX_SECONDS));
  const duration = opts.videoDurationSeconds
    ? Math.round(Number(opts.videoDurationSeconds))
    : session.videoDurationSeconds;
  const newActiveSeconds = session.activeWatchSeconds + clampedDelta;
  const rawPosition = Math.max(0, Math.round(Number(opts.lastPositionSeconds) || session.lastPositionSeconds));
  const clampedPosition = duration ? Math.min(rawPosition, duration) : rawPosition;
  const pct = duration && duration > 0 ? Math.min(100, Math.round((clampedPosition / duration) * 100)) : session.completionPercentage;
  const justCompleted = !session.completed && !!duration && duration > 0 && clampedPosition / duration >= VIDEO_COMPLETION_THRESHOLD;

  const [updated] = await db
    .update(videoWatchSessions)
    .set({
      activeWatchSeconds: newActiveSeconds,
      lastPositionSeconds: clampedPosition,
      videoDurationSeconds: duration,
      completionPercentage: pct,
      completed: session.completed || justCompleted,
      completedAt: session.completedAt || (justCompleted ? new Date() : null),
      firstPlayedAt: session.firstPlayedAt || (opts.firstPlay ? new Date() : null),
      lastActivityAt: new Date(),
      updatedAt: new Date(),
      ...(opts.extra || {}),
    })
    .where(eq(videoWatchSessions.id, session.id))
    .returning();

  return updated;
}

const app = express();

// Requests are JSON bodies only (quiz text, YouTube URLs, etc) now that
// raw video files are no longer accepted — no need for the large limit
// that base64-encoded video uploads used to require.
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// API HEALTH CHECK
app.get('/api/health', async (req, res) => {
  const dbStatus = await checkDatabaseConnection();
  res.json({
    status: dbStatus.ok ? 'ok' : 'degraded',
    database: dbStatus.ok ? 'connected' : 'unavailable',
    timestamp: new Date().toISOString(),
  });
});

// ----------------------------------------------------
// HOMES ENDPOINTS
// ----------------------------------------------------
app.get('/api/homes', async (req, res) => {
  try {
    const allHomes = await db.select().from(homes).orderBy(asc(homes.id));
    res.json(allHomes);
  } catch (err: any) {
    sendServerError(res, err, 'Error fetching homes');
  }
});

app.post('/api/homes', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { name, code } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'Home name is required' });
    }
    const homeCode = code || name.substring(0, 5).toUpperCase();
    const [newHome] = await db
      .insert(homes)
      .values({ name, code: homeCode })
      .returning();
    res.status(201).json(newHome);
  } catch (err: any) {
    sendServerError(res, err, 'Error creating home');
  }
});

// ----------------------------------------------------
// AUTHENTICATION & OTP RECOVERY ENDPOINTS
// ----------------------------------------------------
app.post('/api/auth/login', async (req, res) => {
  try {
    const { identifier, password, homeId, role } = req.body;

    if (!identifier || !password) {
      return res.status(400).json({ error: 'Email/username and password are required' });
    }

    // Find user matching email OR username
    const [user] = await db
      .select({
        id: users.id,
        uid: users.uid,
        email: users.email,
        username: users.username,
        role: users.role,
        homeId: users.homeId,
        homeName: homes.name,
        passwordHash: users.passwordHash,
        mustChangePassword: users.mustChangePassword,
      })
      .from(users)
      .leftJoin(homes, eq(users.homeId, homes.id))
      .where(
        sql`LOWER(${users.email}) = LOWER(${identifier}) OR LOWER(${users.username}) = LOWER(${identifier})`
      );

    // Always run a bcrypt comparison, even for an unknown user, against a
    // fixed dummy hash — otherwise a missing account short-circuits before
    // hashing while a wrong password takes the full bcrypt round-trip,
    // letting an attacker time-distinguish valid emails/usernames.
    const passwordOk = await verifyPassword(password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);

    if (!user || !passwordOk) {
      return res.status(401).json({
        error: 'Invalid credentials. Please check your email/username and password.',
      });
    }

    // Check role if specified
    if (role && user.role !== role) {
      return res.status(403).json({
        error: `Access Denied: Account role is '${user.role}', not '${role}'.`,
      });
    }

    // Check Home Verification: Staff cannot enter a home where they are not assigned!
    if (user.role === 'staff' && homeId) {
      if (user.homeId !== parseInt(homeId, 10)) {
        return res.status(403).json({
          error: `Access Denied: You are registered at '${user.homeName || 'another location'}'. You cannot log in to this location without authorization.`,
        });
      }
    }

    // An admin-set initial password must be changed before the account
    // gets a real session — hand back a short-lived, single-purpose token
    // instead of logging them in.
    if (user.mustChangePassword) {
      const changeToken = createPasswordChangeToken(user.id);
      return res.json({
        requiresPasswordChange: true,
        changeToken,
        message: 'Your password was set by an administrator. Please choose a new password to continue.',
      });
    }

    // Issue a signed, httpOnly session cookie. Downstream requests are
    // authenticated from this cookie server-side — the client never gets
    // to assert its own user id again after this point.
    const sessionToken = createSessionToken(user.id);
    res.cookie(SESSION_COOKIE_NAME, sessionToken, getSessionCookieOptions());

    res.json({
      message: 'Login successful',
      user: {
        id: user.id,
        uid: user.uid,
        email: user.email,
        username: user.username,
        role: user.role,
        homeId: user.homeId,
        homeName: user.homeName,
      },
    });
  } catch (err: any) {
    sendServerError(res, err, 'auth/login');
  }
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
  res.json({ message: 'Logged out successfully' });
});

// Completes the forced first-login password change. Requires the
// short-lived changeToken issued by /api/auth/login, not a session cookie
// — the account isn't fully logged in until this succeeds.
app.post('/api/auth/set-initial-password', async (req, res) => {
  try {
    const { changeToken, newPassword } = req.body;
    if (!changeToken || !newPassword) {
      return res.status(400).json({ error: 'A change token and new password are required' });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }

    const userId = verifyPasswordChangeToken(changeToken);
    if (userId === null) {
      return res.status(401).json({ error: 'This password-change link has expired. Please log in again.' });
    }

    const newPasswordHash = await hashPassword(newPassword);
    const [updated] = await db
      .update(users)
      .set({ passwordHash: newPasswordHash, mustChangePassword: false })
      .where(eq(users.id, userId))
      .returning({
        id: users.id,
        uid: users.uid,
        email: users.email,
        username: users.username,
        role: users.role,
        homeId: users.homeId,
      });

    if (!updated) {
      return res.status(401).json({ error: 'Account not found' });
    }

    // Password is set — log them in for real now.
    const sessionToken = createSessionToken(updated.id);
    res.cookie(SESSION_COOKIE_NAME, sessionToken, getSessionCookieOptions());

    res.json({ message: 'Password set successfully', user: updated });
  } catch (err: any) {
    sendServerError(res, err, 'auth/set-initial-password');
  }
});

// Request a password-reset OTP. Always responds with the same generic
// message whether or not the email is registered, so this endpoint can't
// be used to enumerate valid accounts.
app.post('/api/auth/request-otp', async (req, res) => {
  const genericResponse = {
    message: 'If an account exists for that email, a verification code has been sent to it.',
  };

  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const [user] = await db
      .select()
      .from(users)
      .where(sql`LOWER(${users.email}) = LOWER(${email})`);

    if (!user) {
      return res.json(genericResponse);
    }

    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
    const otpExpiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 mins

    try {
      await sendOtpEmail(user.email, otpCode);
    } catch (mailErr: any) {
      if (mailErr instanceof EmailNotConfiguredError) {
        console.error('[auth/request-otp] Email is not configured:', mailErr.message);
        return res.status(503).json({
          error: {
            code: 'EMAIL_UNAVAILABLE',
            message:
              'Password reset emails are not available right now. Please contact an administrator.',
          },
        });
      }
      throw mailErr;
    }

    // Only persist the OTP once the email actually went out, so a failed
    // send never leaves a valid-but-undelivered code sitting in the DB.
    await db.update(users).set({ otpCode, otpExpiresAt }).where(eq(users.id, user.id));

    res.json(genericResponse);
  } catch (err: any) {
    sendServerError(res, err, 'OTP request error');
  }
});

// Verify an emailed OTP and set a new password.
app.post('/api/auth/verify-otp', async (req, res) => {
  try {
    const { email, otpCode, newPassword } = req.body;
    if (!email || !otpCode || !newPassword) {
      return res.status(400).json({ error: 'Email, OTP code, and a new password are required' });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }

    const [user] = await db
      .select()
      .from(users)
      .where(sql`LOWER(${users.email}) = LOWER(${email})`);

    if (!user) {
      return res.status(400).json({ error: 'Invalid or expired verification code' });
    }

    if (!user.otpCode || user.otpCode !== otpCode) {
      return res.status(400).json({ error: 'Invalid verification code' });
    }

    if (user.otpExpiresAt && new Date(user.otpExpiresAt) < new Date()) {
      return res.status(400).json({ error: 'Verification code has expired' });
    }

    const newPasswordHash = await hashPassword(newPassword);
    await db
      .update(users)
      .set({ passwordHash: newPasswordHash, mustChangePassword: false, otpCode: null, otpExpiresAt: null })
      .where(eq(users.id, user.id));

    res.json({
      message: 'Password reset successfully. You can now log in with your new password.',
      username: user.username,
      email: user.email,
    });
  } catch (err: any) {
    sendServerError(res, err, 'OTP verify error');
  }
});

// Current session user details
app.get('/api/auth/me', requireAuth, async (req: AuthRequest, res) => {
  res.json({ user: req.user });
});

// ----------------------------------------------------
// SECTIONS & VIDEOS ENDPOINTS
// ----------------------------------------------------
app.get('/api/sections', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id;
    const isAdmin = req.user!.role === 'admin';
    // Only admins may ever see archived content, and only when explicitly
    // requested (the dedicated course-management view) — never on the
    // regular staff/admin dashboard listing.
    const includeArchived = isAdmin && req.query.includeArchived === 'true';

    // Staff only ever see sections they have a course assignment for —
    // admins manage/see everything (including archived, via a separate
    // management view) but staff never get the unfiltered list.
    let myAssignments: (typeof courseAssignments.$inferSelect)[] = [];
    if (!isAdmin) {
      myAssignments = await db.select().from(courseAssignments).where(eq(courseAssignments.userId, userId));
    }
    const assignmentBySection = new Map(myAssignments.map((a) => [a.sectionId, a]));

    const allSections = await db
      .select()
      .from(sections)
      .where(includeArchived ? sql`true` : eq(sections.isArchived, false))
      .orderBy(asc(sections.orderNum));
    const visibleSections = isAdmin ? allSections : allSections.filter((s) => assignmentBySection.has(s.id));

    const allVideos = await db
      .select()
      .from(videos)
      .where(includeArchived ? sql`true` : eq(videos.isArchived, false))
      .orderBy(asc(videos.orderNum));
    const allProgress = await db
      .select()
      .from(userProgress)
      .where(eq(userProgress.userId, userId));

    const progressMap = new Map(allProgress.map((p) => [p.videoId, p]));

    // Format response with video progress
    const result = visibleSections.map((sec) => {
      const sectionVideos = allVideos
        .filter((v) => v.sectionId === sec.id)
        .map((vid) => {
          const p = progressMap.get(vid.id);
          return {
            ...vid,
            percentage: p?.percentage || 0,
            watchedFinished: p?.watchedFinished || false,
            quizCompleted: p?.quizCompleted || false,
            quizScore: p?.quizScore || 0,
            passed: p?.passed || false,
          };
        });

      const assignment = assignmentBySection.get(sec.id);
      return {
        ...sec,
        videos: sectionVideos,
        required: isAdmin ? undefined : assignment?.required ?? true,
        dueDate: isAdmin ? undefined : assignment?.dueDate ?? null,
      };
    });

    res.json(result);
  } catch (err: any) {
    sendServerError(res, err, 'Error fetching sections');
  }
});

app.post('/api/sections', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { title, description } = req.body;
    if (!title) {
      return res.status(400).json({ error: 'Section title is required' });
    }

    const [maxOrd] = await db
      .select({ max: sql<number>`COALESCE(MAX(${sections.orderNum}), 0)` })
      .from(sections);

    const [newSec] = await db
      .insert(sections)
      .values({
        title,
        description: description || '',
        orderNum: (maxOrd?.max || 0) + 1,
      })
      .returning();

    res.status(201).json(newSec);
  } catch (err: any) {
    sendServerError(res, err, 'Error creating section');
  }
});

app.put('/api/sections/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const sectionId = parseInt(req.params.id, 10);
    const { title, description } = req.body;

    const [updated] = await db
      .update(sections)
      .set({ title, description })
      .where(eq(sections.id, sectionId))
      .returning();

    res.json(updated);
  } catch (err: any) {
    sendServerError(res, err, 'Error updating section');
  }
});

// Deletes only when the section has zero staff activity attached to it
// (no assignments, and none of its videos have progress/watch/quiz
// history) — otherwise archives it instead so historical reporting for
// staff who trained on it stays intact.
app.delete('/api/sections/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const sectionId = parseInt(req.params.id, 10);
    const [existing] = await db.select().from(sections).where(eq(sections.id, sectionId));
    if (!existing) {
      return res.status(404).json({ error: 'Section not found' });
    }

    const hasHistory = await sectionHasHistory(sectionId);
    if (hasHistory) {
      await db.update(sections).set({ isArchived: true, archivedAt: new Date() }).where(eq(sections.id, sectionId));
      await db.update(videos).set({ isArchived: true, archivedAt: new Date() }).where(eq(videos.sectionId, sectionId));
      return res.json({
        message: 'This course has staff training history, so it was archived instead of deleted — completion records are preserved.',
        archived: true,
      });
    }

    const sectionVideos = await db.select({ id: videos.id }).from(videos).where(eq(videos.sectionId, sectionId));
    const videoIds = sectionVideos.map((v) => v.id);
    if (videoIds.length > 0) {
      await db.delete(quizQuestions).where(inArray(quizQuestions.videoId, videoIds));
      await db.delete(videos).where(eq(videos.sectionId, sectionId));
    }
    await db.delete(sections).where(eq(sections.id, sectionId));
    res.json({ message: 'Section deleted successfully', archived: false });
  } catch (err: any) {
    sendServerError(res, err, 'Error deleting section');
  }
});

app.patch('/api/sections/:id/archive', requireAuth, requireAdmin, async (req, res) => {
  try {
    const sectionId = parseInt(req.params.id, 10);
    const { archived } = req.body;
    if (typeof archived !== 'boolean') {
      return res.status(400).json({ error: 'archived (boolean) is required' });
    }
    const [updated] = await db
      .update(sections)
      .set({ isArchived: archived, archivedAt: archived ? new Date() : null })
      .where(eq(sections.id, sectionId))
      .returning();
    if (!updated) {
      return res.status(404).json({ error: 'Section not found' });
    }
    res.json(updated);
  } catch (err: any) {
    sendServerError(res, err, 'Error updating section archive state');
  }
});

// Fetch video details and its quiz questions
app.get('/api/videos/:id', requireAuth, async (req: AuthRequest, res) => {
  try {
    const videoId = parseInt(req.params.id, 10);
    const userId = req.user!.id;
    const isAdmin = req.user!.role === 'admin';

    const [vid] = await db.select().from(videos).where(eq(videos.id, videoId));
    if (!vid || (vid.isArchived && !isAdmin)) {
      return res.status(404).json({ error: 'Video not found' });
    }

    if (!isAdmin) {
      const [assignment] = await db
        .select({ id: courseAssignments.id })
        .from(courseAssignments)
        .where(and(eq(courseAssignments.userId, userId), eq(courseAssignments.sectionId, vid.sectionId)));
      if (!assignment) {
        return res.status(403).json({ error: 'You are not assigned to this course' });
      }
    }

    const questions = await db
      .select()
      .from(quizQuestions)
      .where(eq(quizQuestions.videoId, videoId))
      .orderBy(asc(quizQuestions.id));

    const [prog] = await db
      .select()
      .from(userProgress)
      .where(
        and(eq(userProgress.userId, userId), eq(userProgress.videoId, videoId))
      );

    // Most recent watch session gives us the "Resume from mm:ss" position,
    // even if that session was never marked complete.
    const [latestSession] = await db
      .select({ lastPositionSeconds: videoWatchSessions.lastPositionSeconds })
      .from(videoWatchSessions)
      .where(and(eq(videoWatchSessions.userId, userId), eq(videoWatchSessions.videoId, videoId)))
      .orderBy(desc(videoWatchSessions.lastActivityAt))
      .limit(1);

    res.json({
      ...vid,
      quizQuestions: questions,
      lastPositionSeconds: latestSession?.lastPositionSeconds || 0,
      completionThreshold: VIDEO_COMPLETION_THRESHOLD,
      progress: prog || {
        percentage: 0,
        watchedFinished: false,
        quizCompleted: false,
        quizScore: 0,
        passed: false,
      },
    });
  } catch (err: any) {
    sendServerError(res, err, 'Error fetching video');
  }
});

// Admin add video with 3 quiz questions
app.post('/api/videos', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { sectionId, title, description, url, durationSeconds, questions } = req.body;

    if (!sectionId || !title || !url) {
      return res.status(400).json({ error: 'Section ID, title, and video URL are required' });
    }

    const [maxOrd] = await db
      .select({ max: sql<number>`COALESCE(MAX(${videos.orderNum}), 0)` })
      .from(videos)
      .where(eq(videos.sectionId, sectionId));

    const [newVid] = await db
      .insert(videos)
      .values({
        sectionId,
        title,
        description: description || '',
        url,
        durationSeconds: durationSeconds || 180,
        orderNum: (maxOrd?.max || 0) + 1,
      })
      .returning();

    if (Array.isArray(questions) && questions.length > 0) {
      for (const q of questions) {
        await db.insert(quizQuestions).values({
          videoId: newVid.id,
          question: q.question,
          options: q.options,
          correctIndex: q.correctIndex,
          explanation: q.explanation || '',
        });
      }
    }

    res.status(201).json(newVid);
  } catch (err: any) {
    sendServerError(res, err, 'Error creating video');
  }
});

app.delete('/api/videos/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const videoId = parseInt(req.params.id, 10);
    const [existing] = await db.select().from(videos).where(eq(videos.id, videoId));
    if (!existing) {
      return res.status(404).json({ error: 'Video not found' });
    }

    const hasHistory = await videosHaveHistory([videoId]);
    if (hasHistory) {
      await db.update(videos).set({ isArchived: true, archivedAt: new Date() }).where(eq(videos.id, videoId));
      return res.json({
        message: 'This video has staff watch or quiz history, so it was archived instead of deleted.',
        archived: true,
      });
    }

    await db.delete(quizQuestions).where(eq(quizQuestions.videoId, videoId));
    await db.delete(videos).where(eq(videos.id, videoId));
    res.json({ message: 'Video deleted successfully', archived: false });
  } catch (err: any) {
    sendServerError(res, err, 'Error deleting video');
  }
});

app.patch('/api/videos/:id/archive', requireAuth, requireAdmin, async (req, res) => {
  try {
    const videoId = parseInt(req.params.id, 10);
    const { archived } = req.body;
    if (typeof archived !== 'boolean') {
      return res.status(400).json({ error: 'archived (boolean) is required' });
    }
    const [updated] = await db
      .update(videos)
      .set({ isArchived: archived, archivedAt: archived ? new Date() : null })
      .where(eq(videos.id, videoId))
      .returning();
    if (!updated) {
      return res.status(404).json({ error: 'Video not found' });
    }
    res.json(updated);
  } catch (err: any) {
    sendServerError(res, err, 'Error updating video archive state');
  }
});

// ----------------------------------------------------
// VIDEO WATCH SESSION TRACKING
// ----------------------------------------------------
// Opens a new watch session for this "sitting". Staff must be assigned to
// the video's section — identity and ownership always come from the
// session, never from the request body.
app.post('/api/watch-sessions', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id;
    const isAdmin = req.user!.role === 'admin';
    const { videoId, startPositionSeconds } = req.body;

    if (!videoId) {
      return res.status(400).json({ error: 'videoId is required' });
    }

    const [vid] = await db.select().from(videos).where(eq(videos.id, videoId));
    if (!vid) {
      return res.status(404).json({ error: 'Video not found' });
    }

    if (!isAdmin) {
      const [assignment] = await db
        .select({ id: courseAssignments.id })
        .from(courseAssignments)
        .where(and(eq(courseAssignments.userId, userId), eq(courseAssignments.sectionId, vid.sectionId)));
      if (!assignment) {
        return res.status(403).json({ error: 'You are not assigned to this course' });
      }
    }

    const startPos = Math.max(0, Math.round(Number(startPositionSeconds) || 0));
    const [session] = await db
      .insert(videoWatchSessions)
      .values({
        userId,
        videoId,
        startPositionSeconds: startPos,
        lastPositionSeconds: startPos,
        videoDurationSeconds: vid.durationSeconds,
      })
      .returning();

    res.status(201).json(session);
  } catch (err: any) {
    sendServerError(res, err, 'Error opening watch session');
  }
});

// Periodic heartbeat while actively playing. `activeSecondsDelta` is
// clamped server-side so a tampered client can't inflate watched time
// beyond what a real heartbeat interval could have produced.
app.patch('/api/watch-sessions/:id', requireAuth, async (req: AuthRequest, res) => {
  try {
    const sessionId = parseInt(req.params.id, 10);
    const userId = req.user!.id;
    const { activeSecondsDelta, lastPositionSeconds, videoDurationSeconds, firstPlay } = req.body;

    const [session] = await db.select().from(videoWatchSessions).where(eq(videoWatchSessions.id, sessionId));
    if (!session) {
      return res.status(404).json({ error: 'Watch session not found' });
    }
    if (session.userId !== userId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const updated = await applyWatchSessionUpdate(session, {
      activeSecondsDelta,
      lastPositionSeconds,
      videoDurationSeconds,
      firstPlay,
    });

    await syncUserProgressFromSessions(userId, session.videoId);

    res.json(updated);
  } catch (err: any) {
    sendServerError(res, err, 'Error updating watch session');
  }
});

// Final flush on pause/end/tab-hide/navigation-away. Accepts the
// application/json content-type navigator.sendBeacon sends, since it goes
// through the same express.json() middleware as a normal request.
app.post('/api/watch-sessions/:id/close', requireAuth, async (req: AuthRequest, res) => {
  try {
    const sessionId = parseInt(req.params.id, 10);
    const userId = req.user!.id;
    const { exitReason, lastPositionSeconds, activeSecondsDelta } = req.body;

    const [session] = await db.select().from(videoWatchSessions).where(eq(videoWatchSessions.id, sessionId));
    if (!session) {
      return res.status(404).json({ error: 'Watch session not found' });
    }
    if (session.userId !== userId) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (session.closedAt) {
      return res.json(session); // already closed — idempotent for retried beacons
    }

    const updated = await applyWatchSessionUpdate(session, {
      activeSecondsDelta,
      lastPositionSeconds,
      extra: {
        closedAt: new Date(),
        exitReason: typeof exitReason === 'string' ? exitReason.slice(0, 100) : null,
      },
    });

    await syncUserProgressFromSessions(userId, session.videoId);

    res.json(updated);
  } catch (err: any) {
    sendServerError(res, err, 'Error closing watch session');
  }
});

// Submit quiz answers
app.post('/api/progress/quiz', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id;
    const { videoId, answers, startedAt } = req.body; // array of selected option indices e.g. [1, 1, 1]

    if (!videoId || !Array.isArray(answers)) {
      return res.status(400).json({ error: 'Video ID and answers array are required' });
    }

    // Check if user finished video first
    const [prog] = await db
      .select()
      .from(userProgress)
      .where(
        and(eq(userProgress.userId, userId), eq(userProgress.videoId, videoId))
      );

    if (!prog || !prog.watchedFinished) {
      return res.status(400).json({
        error: 'You must complete watching the video before taking the quiz!',
      });
    }

    const questions = await db
      .select()
      .from(quizQuestions)
      .where(eq(quizQuestions.videoId, videoId))
      .orderBy(asc(quizQuestions.id));

    if (questions.length === 0) {
      return res.status(400).json({ error: 'No quiz questions available for this video' });
    }

    let score = 0;
    const questionResults = questions.map((q, idx) => {
      const userChoice = answers[idx];
      const isCorrect = userChoice === q.correctIndex;
      if (isCorrect) score++;
      return {
        questionId: q.id,
        question: q.question,
        userChoice,
        correctIndex: q.correctIndex,
        isCorrect,
        explanation: q.explanation,
      };
    });

    const totalQuestions = questions.length;
    const passed = score >= 2; // Must get at least 2/3 to pass and move forward!

    const [updatedProg] = await db
      .update(userProgress)
      .set({
        quizCompleted: true,
        quizScore: score,
        passed: passed || prog.passed,
        updatedAt: new Date(),
      })
      .where(eq(userProgress.id, prog.id))
      .returning();

    // Record every attempt for the staff detail report — score/pass are
    // always computed server-side above, never trusted from the client.
    const [{ priorAttempts }] = await db
      .select({ priorAttempts: sql<number>`COUNT(*)` })
      .from(quizAttempts)
      .where(and(eq(quizAttempts.userId, userId), eq(quizAttempts.videoId, videoId)));
    const attemptNumber = Number(priorAttempts) + 1;

    const startedAtDate = typeof startedAt === 'string' ? new Date(startedAt) : null;
    const submittedAtDate = new Date();
    const timeSpentSeconds =
      startedAtDate && !isNaN(startedAtDate.getTime())
        ? Math.max(0, Math.round((submittedAtDate.getTime() - startedAtDate.getTime()) / 1000))
        : null;

    await db.insert(quizAttempts).values({
      userId,
      videoId,
      attemptNumber,
      startedAt: startedAtDate,
      submittedAt: submittedAtDate,
      score,
      maximumScore: totalQuestions,
      percentage: Math.round((score / totalQuestions) * 100),
      passed,
      timeSpentSeconds,
      answers,
    });

    res.json({
      score,
      total: totalQuestions,
      passed,
      attemptNumber,
      message: passed
        ? 'Congratulations! You passed the quiz (at least 2/3 required). Next section unlocked!'
        : `You scored ${score}/${totalQuestions}. You must score at least 2 out of 3 to pass and proceed. Please review the video and try again!`,
      questionResults,
      progress: updatedProg,
    });
  } catch (err: any) {
    sendServerError(res, err, 'Error submitting quiz');
  }
});

// ----------------------------------------------------
// ADMIN REPORTS & USER MANAGEMENT ENDPOINTS
// ----------------------------------------------------
app.get('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const roleFilter = req.query.role;
    const roleCondition =
      roleFilter === 'staff' || roleFilter === 'admin' ? eq(users.role, roleFilter) : sql`true`;

    const allUsers = await db
      .select({
        id: users.id,
        uid: users.uid,
        email: users.email,
        username: users.username,
        role: users.role,
        homeId: users.homeId,
        homeName: homes.name,
        mustChangePassword: users.mustChangePassword,
        createdAt: users.createdAt,
      })
      .from(users)
      .leftJoin(homes, eq(users.homeId, homes.id))
      .where(roleCondition)
      .orderBy(asc(users.id));

    res.json(allUsers);
  } catch (err: any) {
    sendServerError(res, err, 'Error fetching users');
  }
});

app.post('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { email, username, role, homeId, password } = req.body;

    if (!email || !username || !password) {
      return res.status(400).json({ error: 'Email, username, and password are required' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const customUid = `user_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const passwordHash = await hashPassword(password);

    const [newUser] = await db
      .insert(users)
      .values({
        uid: customUid,
        email,
        username,
        role: role || 'staff',
        homeId: homeId ? parseInt(homeId, 10) : null,
        passwordHash,
        // The admin set this password directly, so force the user to pick
        // their own the first time they log in with it.
        mustChangePassword: true,
      })
      .returning({
        id: users.id,
        uid: users.uid,
        email: users.email,
        username: users.username,
        role: users.role,
        homeId: users.homeId,
      });

    res.status(201).json(newUser);
  } catch (err: any) {
    sendServerError(res, err, 'Error creating user');
  }
});

app.put('/api/admin/users/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const userId = parseInt(req.params.id, 10);
    const { email, username, role, homeId, password } = req.body;

    if (password && password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const updateData: any = {};
    if (email) updateData.email = email;
    if (username) updateData.username = username;
    if (role) updateData.role = role;
    if (homeId !== undefined) updateData.homeId = homeId ? parseInt(homeId, 10) : null;
    if (password) {
      updateData.passwordHash = await hashPassword(password);
      // Same reasoning as account creation: an admin-set password must be
      // changed by the user before it's trusted long-term.
      updateData.mustChangePassword = true;
    }

    const [updated] = await db
      .update(users)
      .set(updateData)
      .where(eq(users.id, userId))
      .returning({
        id: users.id,
        uid: users.uid,
        email: users.email,
        username: users.username,
        role: users.role,
        homeId: users.homeId,
      });

    res.json(updated);
  } catch (err: any) {
    sendServerError(res, err, 'Error updating user');
  }
});

app.delete('/api/admin/users/:id', requireAuth, requireAdmin, async (req: AuthRequest, res) => {
  try {
    const userId = parseInt(req.params.id, 10);
    if (req.user && userId === req.user.id) {
      return res.status(400).json({ error: 'You cannot delete your own active admin account!' });
    }
    await db.delete(userProgress).where(eq(userProgress.userId, userId));
    await db.delete(users).where(eq(users.id, userId));
    res.json({ message: 'User deleted successfully' });
  } catch (err: any) {
    sendServerError(res, err, 'Error deleting user');
  }
});

// ----------------------------------------------------
// TRAINING ASSIGNMENTS
// ----------------------------------------------------
app.post('/api/admin/assignments', requireAuth, requireAdmin, async (req: AuthRequest, res) => {
  try {
    const { userId, sectionId, required, dueDate } = req.body;
    if (!userId || !sectionId) {
      return res.status(400).json({ error: 'userId and sectionId are required' });
    }

    const [targetUser] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId));
    if (!targetUser) {
      return res.status(404).json({ error: 'Staff member not found' });
    }
    const [section] = await db.select({ id: sections.id }).from(sections).where(eq(sections.id, sectionId));
    if (!section) {
      return res.status(404).json({ error: 'Course not found' });
    }

    const [existing] = await db
      .select({ id: courseAssignments.id })
      .from(courseAssignments)
      .where(and(eq(courseAssignments.userId, userId), eq(courseAssignments.sectionId, sectionId)));
    if (existing) {
      return res.status(409).json({ error: 'This course is already assigned to this staff member' });
    }

    const [created] = await db
      .insert(courseAssignments)
      .values({
        userId,
        sectionId,
        assignedBy: req.user!.id,
        required: required === undefined ? true : !!required,
        dueDate: dueDate ? new Date(dueDate) : null,
      })
      .returning();

    res.status(201).json(created);
  } catch (err: any) {
    if (err?.code === '23505') {
      return res.status(409).json({ error: 'This course is already assigned to this staff member' });
    }
    sendServerError(res, err, 'Error creating assignment');
  }
});

app.post('/api/admin/assignments/bulk', requireAuth, requireAdmin, async (req: AuthRequest, res) => {
  try {
    const { userIds, sectionIds, required, dueDate } = req.body;
    if (!Array.isArray(userIds) || userIds.length === 0 || !Array.isArray(sectionIds) || sectionIds.length === 0) {
      return res.status(400).json({ error: 'userIds and sectionIds arrays are required' });
    }

    const existing = await db
      .select({ userId: courseAssignments.userId, sectionId: courseAssignments.sectionId })
      .from(courseAssignments)
      .where(and(inArray(courseAssignments.userId, userIds), inArray(courseAssignments.sectionId, sectionIds)));
    const existingKeys = new Set(existing.map((e) => `${e.userId}:${e.sectionId}`));

    const rowsToInsert: (typeof courseAssignments.$inferInsert)[] = [];
    for (const uid of userIds) {
      for (const sid of sectionIds) {
        if (!existingKeys.has(`${uid}:${sid}`)) {
          rowsToInsert.push({
            userId: uid,
            sectionId: sid,
            assignedBy: req.user!.id,
            required: required === undefined ? true : !!required,
            dueDate: dueDate ? new Date(dueDate) : null,
          });
        }
      }
    }

    const created = rowsToInsert.length > 0 ? await db.insert(courseAssignments).values(rowsToInsert).returning() : [];
    res.status(201).json({
      created: created.length,
      skipped: userIds.length * sectionIds.length - created.length,
    });
  } catch (err: any) {
    sendServerError(res, err, 'Error creating bulk assignments');
  }
});

app.delete('/api/admin/assignments/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const [deleted] = await db.delete(courseAssignments).where(eq(courseAssignments.id, id)).returning();
    if (!deleted) {
      return res.status(404).json({ error: 'Assignment not found' });
    }
    res.json({ message: 'Assignment removed successfully' });
  } catch (err: any) {
    sendServerError(res, err, 'Error removing assignment');
  }
});

// Admin completion report across all staff — richer than a single
// percentage: assigned/completed/outstanding counts, average quiz score,
// last activity, and a status label, sourced from assignments + watch
// sessions + quiz attempts (not just the legacy userProgress percentage).
app.get('/api/admin/reports', requireAuth, requireAdmin, async (req, res) => {
  try {
    const [staffMembers, allAssignments, allVids, allProg, allQuizAttempts] = await Promise.all([
      db
        .select({
          id: users.id,
          username: users.username,
          email: users.email,
          homeName: homes.name,
        })
        .from(users)
        .leftJoin(homes, eq(users.homeId, homes.id))
        .where(eq(users.role, 'staff')),
      db.select().from(courseAssignments),
      db.select({ id: videos.id, sectionId: videos.sectionId }).from(videos).where(eq(videos.isArchived, false)),
      db.select().from(userProgress),
      db.select().from(quizAttempts),
    ]);

    const assignmentsByUser = new Map<number, typeof allAssignments>();
    for (const a of allAssignments) {
      const list = assignmentsByUser.get(a.userId);
      if (list) list.push(a);
      else assignmentsByUser.set(a.userId, [a]);
    }
    const videosBySection = new Map<number, typeof allVids>();
    for (const v of allVids) {
      const list = videosBySection.get(v.sectionId);
      if (list) list.push(v);
      else videosBySection.set(v.sectionId, [v]);
    }
    const progressByUser = new Map<number, typeof allProg>();
    for (const p of allProg) {
      const list = progressByUser.get(p.userId);
      if (list) list.push(p);
      else progressByUser.set(p.userId, [p]);
    }
    const quizAttemptsByUser = new Map<number, typeof allQuizAttempts>();
    for (const q of allQuizAttempts) {
      const list = quizAttemptsByUser.get(q.userId);
      if (list) list.push(q);
      else quizAttemptsByUser.set(q.userId, [q]);
    }

    const reports = staffMembers.map((st) => {
      const staffAssignments = assignmentsByUser.get(st.id) || [];
      const assignedSectionIds = new Set(staffAssignments.map((a) => a.sectionId));
      const assignedVideos = [...assignedSectionIds].flatMap((sectionId) => videosBySection.get(sectionId) || []);
      const staffProgress = progressByUser.get(st.id) || [];
      const progressByVideo = new Map(staffProgress.map((p) => [p.videoId, p]));

      const completedVideos = assignedVideos.filter((v) => progressByVideo.get(v.id)?.passed).length;
      const totalVideos = assignedVideos.length;
      const outstandingVideos = totalVideos - completedVideos;
      const completionPercentage = totalVideos > 0 ? Math.round((completedVideos / totalVideos) * 100) : 0;

      const staffQuizAttempts = quizAttemptsByUser.get(st.id) || [];
      const avgQuizScore =
        staffQuizAttempts.length > 0
          ? Math.round(staffQuizAttempts.reduce((sum, q) => sum + q.percentage, 0) / staffQuizAttempts.length)
          : null;

      const activityDates = [
        ...staffProgress.map((p) => p.updatedAt),
        ...staffQuizAttempts.map((q) => q.submittedAt),
      ].filter(Boolean) as Date[];
      const lastActivity =
        activityDates.length > 0 ? new Date(Math.max(...activityDates.map((d) => new Date(d).getTime()))) : null;

      const status =
        totalVideos === 0
          ? 'no_assignments'
          : completedVideos === 0
            ? 'not_started'
            : completedVideos === totalVideos
              ? 'completed'
              : 'in_progress';

      return {
        userId: st.id,
        username: st.username,
        email: st.email,
        homeName: st.homeName || 'Unassigned',
        assignedCourses: staffAssignments.length,
        completedVideos,
        totalVideos,
        outstandingVideos,
        completionPercentage,
        avgQuizScore,
        lastActivity,
        status,
      };
    });

    res.json(reports);
  } catch (err: any) {
    sendServerError(res, err, 'Error generating report');
  }
});

// ----------------------------------------------------
// ADMIN DASHBOARD SUMMARY
// ----------------------------------------------------
app.get('/api/admin/dashboard-summary', requireAuth, requireAdmin, async (req, res) => {
  try {
    const [
      counts,
      allAssignments,
      allVids,
      allProg,
      recentSections,
      recentVideos,
      recentAssignments,
      recentCompletions,
      allSectionsList,
    ] = await Promise.all([
      // Four independent counts in one round trip instead of four —
      // each round trip to the hosted DB costs ~150-250ms regardless of
      // how small the result is, so merging is the cheapest win here.
      db.execute<{ staff_count: number; course_count: number; video_count: number; assignment_count: number }>(sql`
        SELECT
          (SELECT COUNT(*) FROM ${users} WHERE ${users.role} = 'staff') AS staff_count,
          (SELECT COUNT(*) FROM ${sections} WHERE ${sections.isArchived} = false) AS course_count,
          (SELECT COUNT(*) FROM ${videos} WHERE ${videos.isArchived} = false) AS video_count,
          (SELECT COUNT(*) FROM ${courseAssignments}) AS assignment_count
      `),
      db.select().from(courseAssignments),
      // Only id/sectionId are actually used below — avoid pulling title/
      // description/url for every video on every dashboard load.
      db.select({ id: videos.id, sectionId: videos.sectionId }).from(videos).where(eq(videos.isArchived, false)),
      db.select().from(userProgress),
      db.select().from(sections).orderBy(desc(sections.createdAt)).limit(5),
      db
        .select({ id: videos.id, title: videos.title, sectionId: videos.sectionId, createdAt: videos.createdAt })
        .from(videos)
        .orderBy(desc(videos.createdAt))
        .limit(5),
      db
        .select({
          id: courseAssignments.id,
          userId: courseAssignments.userId,
          sectionId: courseAssignments.sectionId,
          assignedAt: courseAssignments.assignedAt,
          username: users.username,
          sectionTitle: sections.title,
        })
        .from(courseAssignments)
        .leftJoin(users, eq(courseAssignments.userId, users.id))
        .leftJoin(sections, eq(courseAssignments.sectionId, sections.id))
        .orderBy(desc(courseAssignments.assignedAt))
        .limit(5),
      db
        .select({
          id: userProgress.id,
          userId: userProgress.userId,
          videoId: userProgress.videoId,
          updatedAt: userProgress.updatedAt,
          username: users.username,
          videoTitle: videos.title,
        })
        .from(userProgress)
        .leftJoin(users, eq(userProgress.userId, users.id))
        .leftJoin(videos, eq(userProgress.videoId, videos.id))
        .where(eq(userProgress.passed, true))
        .orderBy(desc(userProgress.updatedAt))
        .limit(5),
      db.select({ id: sections.id, title: sections.title }).from(sections),
    ]);

    const progressKey = (u: number, v: number) => `${u}:${v}`;
    const progressMap = new Map(allProg.map((p) => [progressKey(p.userId, p.videoId), p]));
    const videosBySection = new Map<number, typeof allVids>();
    for (const v of allVids) {
      const list = videosBySection.get(v.sectionId);
      if (list) list.push(v);
      else videosBySection.set(v.sectionId, [v]);
    }

    let completedAssignments = 0;
    const outstandingRequiredStaff = new Set<number>();
    const courseIncompleteCounts = new Map<number, number>();

    for (const a of allAssignments) {
      const sectionVideos = videosBySection.get(a.sectionId) || [];
      const total = sectionVideos.length;
      const done = sectionVideos.filter((v) => progressMap.get(progressKey(a.userId, v.id))?.passed).length;
      const isComplete = total > 0 && done === total;
      if (isComplete) {
        completedAssignments++;
      } else {
        courseIncompleteCounts.set(a.sectionId, (courseIncompleteCounts.get(a.sectionId) || 0) + 1);
        if (a.required) outstandingRequiredStaff.add(a.userId);
      }
    }

    const overallCompletionRate =
      allAssignments.length > 0 ? Math.round((completedAssignments / allAssignments.length) * 100) : 0;

    const sectionTitleMap = new Map(allSectionsList.map((s) => [s.id, s.title]));
    const outstandingCourses = [...courseIncompleteCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([sectionId, incompleteCount]) => ({
        sectionId,
        title: sectionTitleMap.get(sectionId) || 'Unknown course',
        incompleteCount,
      }));

    const countsRow = counts.rows[0];

    res.json({
      summary: {
        totalActiveStaff: Number(countsRow.staff_count),
        totalActiveCourses: Number(countsRow.course_count),
        totalPublishedVideos: Number(countsRow.video_count),
        totalActiveAssignments: Number(countsRow.assignment_count),
        overallCompletionRate,
        staffWithOutstandingRequiredTraining: outstandingRequiredStaff.size,
      },
      recentActivity: {
        courses: recentSections,
        videos: recentVideos,
        assignments: recentAssignments,
        completions: recentCompletions,
      },
      outstandingTraining: {
        staffCount: outstandingRequiredStaff.size,
        topCourses: outstandingCourses,
      },
    });
  } catch (err: any) {
    sendServerError(res, err, 'Error generating dashboard summary');
  }
});

// ----------------------------------------------------
// STAFF DETAIL REPORT (admin-only drill-down)
// ----------------------------------------------------
app.get('/api/admin/staff/:staffId', requireAuth, requireAdmin, async (req, res) => {
  try {
    const staffId = parseInt(req.params.staffId, 10);
    const [staff] = await db
      .select({
        id: users.id,
        uid: users.uid,
        email: users.email,
        username: users.username,
        role: users.role,
        homeId: users.homeId,
        homeName: homes.name,
        createdAt: users.createdAt,
        mustChangePassword: users.mustChangePassword,
      })
      .from(users)
      .leftJoin(homes, eq(users.homeId, homes.id))
      .where(eq(users.id, staffId));
    if (!staff) {
      return res.status(404).json({ error: 'Staff member not found' });
    }

    const [[lastProgress], [lastQuiz], [lastSession]] = await Promise.all([
      db
        .select({ updatedAt: userProgress.updatedAt })
        .from(userProgress)
        .where(eq(userProgress.userId, staffId))
        .orderBy(desc(userProgress.updatedAt))
        .limit(1),
      db
        .select({ submittedAt: quizAttempts.submittedAt })
        .from(quizAttempts)
        .where(eq(quizAttempts.userId, staffId))
        .orderBy(desc(quizAttempts.submittedAt))
        .limit(1),
      db
        .select({ lastActivityAt: videoWatchSessions.lastActivityAt })
        .from(videoWatchSessions)
        .where(eq(videoWatchSessions.userId, staffId))
        .orderBy(desc(videoWatchSessions.lastActivityAt))
        .limit(1),
    ]);

    const dates = [lastProgress?.updatedAt, lastQuiz?.submittedAt, lastSession?.lastActivityAt].filter(
      Boolean
    ) as Date[];
    const lastActivity = dates.length > 0 ? new Date(Math.max(...dates.map((d) => new Date(d).getTime()))) : null;

    res.json({ ...staff, lastActivity });
  } catch (err: any) {
    sendServerError(res, err, 'Error fetching staff member');
  }
});

app.get('/api/admin/staff/:staffId/assignments', requireAuth, requireAdmin, async (req, res) => {
  try {
    const staffId = parseInt(req.params.staffId, 10);
    const rows = await db
      .select({
        id: courseAssignments.id,
        sectionId: courseAssignments.sectionId,
        sectionTitle: sections.title,
        required: courseAssignments.required,
        dueDate: courseAssignments.dueDate,
        assignedAt: courseAssignments.assignedAt,
        assignedBy: courseAssignments.assignedBy,
        assignedByName: users.username,
      })
      .from(courseAssignments)
      .leftJoin(sections, eq(courseAssignments.sectionId, sections.id))
      .leftJoin(users, eq(courseAssignments.assignedBy, users.id))
      .where(eq(courseAssignments.userId, staffId))
      .orderBy(desc(courseAssignments.assignedAt));

    const sectionIds = rows.map((r) => r.sectionId);
    const sectionVideosList =
      sectionIds.length > 0
        ? await db.select().from(videos).where(and(inArray(videos.sectionId, sectionIds), eq(videos.isArchived, false)))
        : [];
    const staffProgress = await db.select().from(userProgress).where(eq(userProgress.userId, staffId));
    const progressByVideo = new Map(staffProgress.map((p) => [p.videoId, p]));

    const result = rows.map((r) => {
      const secVideos = sectionVideosList.filter((v) => v.sectionId === r.sectionId);
      const completedVideos = secVideos.filter((v) => progressByVideo.get(v.id)?.passed).length;
      const totalVideos = secVideos.length;
      const lastActivityDates = secVideos
        .map((v) => progressByVideo.get(v.id)?.updatedAt)
        .filter(Boolean) as Date[];
      const lastActivity =
        lastActivityDates.length > 0
          ? new Date(Math.max(...lastActivityDates.map((d) => new Date(d).getTime())))
          : null;
      const status =
        totalVideos === 0 || completedVideos === 0
          ? 'not_started'
          : completedVideos === totalVideos
            ? 'completed'
            : 'in_progress';
      return {
        ...r,
        completedVideos,
        totalVideos,
        completionPercentage: totalVideos > 0 ? Math.round((completedVideos / totalVideos) * 100) : 0,
        status,
        lastActivity,
      };
    });

    res.json(result);
  } catch (err: any) {
    sendServerError(res, err, 'Error fetching staff assignments');
  }
});

app.get('/api/admin/staff/:staffId/video-activity', requireAuth, requireAdmin, async (req, res) => {
  try {
    const staffId = parseInt(req.params.staffId, 10);
    const allVids = await db
      .select({
        id: videos.id,
        title: videos.title,
        sectionId: videos.sectionId,
        sectionTitle: sections.title,
        durationSeconds: videos.durationSeconds,
      })
      .from(videos)
      .leftJoin(sections, eq(videos.sectionId, sections.id));

    const staffSessions = await db.select().from(videoWatchSessions).where(eq(videoWatchSessions.userId, staffId));
    const staffProgress = await db.select().from(userProgress).where(eq(userProgress.userId, staffId));
    const progressByVideo = new Map(staffProgress.map((p) => [p.videoId, p]));

    const videoIdsWithSessions = new Set(staffSessions.map((s) => s.videoId));
    const relevantVideos = allVids.filter((v) => videoIdsWithSessions.has(v.id));

    const result = relevantVideos.map((v) => {
      const vidSessions = staffSessions
        .filter((s) => s.videoId === v.id)
        .sort((a, b) => new Date(a.openedAt).getTime() - new Date(b.openedAt).getTime());
      const firstOpened = vidSessions[0]?.openedAt || null;
      const lastOpened = vidSessions[vidSessions.length - 1]?.openedAt || null;
      const totalActiveWatchSeconds = vidSessions.reduce((sum, s) => sum + s.activeWatchSeconds, 0);
      const lastPositionSeconds = vidSessions[vidSessions.length - 1]?.lastPositionSeconds || 0;
      const bestPct = vidSessions.reduce((max, s) => Math.max(max, s.completionPercentage), 0);
      const prog = progressByVideo.get(v.id);
      const completed = !!prog?.watchedFinished || vidSessions.some((s) => s.completed);
      const completedAt = vidSessions.find((s) => s.completed)?.completedAt || null;

      return {
        videoId: v.id,
        videoTitle: v.title,
        sectionId: v.sectionId,
        sectionTitle: v.sectionTitle,
        firstOpened,
        lastOpened,
        numberOfSessions: vidSessions.length,
        totalActiveWatchSeconds,
        videoDurationSeconds: v.durationSeconds,
        lastPositionSeconds,
        watchedPercentage: bestPct,
        completed,
        completedAt,
      };
    });

    res.json(result);
  } catch (err: any) {
    sendServerError(res, err, 'Error fetching video activity');
  }
});

app.get('/api/admin/staff/:staffId/video-activity/:videoId/sessions', requireAuth, requireAdmin, async (req, res) => {
  try {
    const staffId = parseInt(req.params.staffId, 10);
    const videoId = parseInt(req.params.videoId, 10);
    const sessionRows = await db
      .select()
      .from(videoWatchSessions)
      .where(and(eq(videoWatchSessions.userId, staffId), eq(videoWatchSessions.videoId, videoId)))
      .orderBy(asc(videoWatchSessions.openedAt));
    res.json(sessionRows);
  } catch (err: any) {
    sendServerError(res, err, 'Error fetching watch sessions');
  }
});

app.get('/api/admin/staff/:staffId/quiz-attempts', requireAuth, requireAdmin, async (req, res) => {
  try {
    const staffId = parseInt(req.params.staffId, 10);
    const rows = await db
      .select({
        id: quizAttempts.id,
        videoId: quizAttempts.videoId,
        videoTitle: videos.title,
        sectionId: videos.sectionId,
        sectionTitle: sections.title,
        attemptNumber: quizAttempts.attemptNumber,
        startedAt: quizAttempts.startedAt,
        submittedAt: quizAttempts.submittedAt,
        score: quizAttempts.score,
        maximumScore: quizAttempts.maximumScore,
        percentage: quizAttempts.percentage,
        passed: quizAttempts.passed,
        timeSpentSeconds: quizAttempts.timeSpentSeconds,
      })
      .from(quizAttempts)
      .leftJoin(videos, eq(quizAttempts.videoId, videos.id))
      .leftJoin(sections, eq(videos.sectionId, sections.id))
      .where(eq(quizAttempts.userId, staffId))
      .orderBy(desc(quizAttempts.submittedAt));
    res.json(rows);
  } catch (err: any) {
    sendServerError(res, err, 'Error fetching quiz attempts');
  }
});

app.get('/api/admin/staff/:staffId/completion-history', requireAuth, requireAdmin, async (req, res) => {
  try {
    const staffId = parseInt(req.params.staffId, 10);
    const rows = await db
      .select({
        videoId: userProgress.videoId,
        videoTitle: videos.title,
        sectionId: videos.sectionId,
        sectionTitle: sections.title,
        updatedAt: userProgress.updatedAt,
        percentage: userProgress.percentage,
        quizScore: userProgress.quizScore,
        passed: userProgress.passed,
      })
      .from(userProgress)
      .leftJoin(videos, eq(userProgress.videoId, videos.id))
      .leftJoin(sections, eq(videos.sectionId, sections.id))
      .where(and(eq(userProgress.userId, staffId), eq(userProgress.passed, true)))
      .orderBy(desc(userProgress.updatedAt));
    res.json(rows);
  } catch (err: any) {
    sendServerError(res, err, 'Error fetching completion history');
  }
});

app.get('/api/admin/staff/:staffId/timeline', requireAuth, requireAdmin, async (req, res) => {
  try {
    const staffId = parseInt(req.params.staffId, 10);
    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10));
    const pageSize = Math.min(100, Math.max(1, parseInt(String(req.query.pageSize || '25'), 10)));

    const [assignmentRows, sessionRows, quizRows] = await Promise.all([
      db
        .select({ sectionTitle: sections.title, assignedAt: courseAssignments.assignedAt })
        .from(courseAssignments)
        .leftJoin(sections, eq(courseAssignments.sectionId, sections.id))
        .where(eq(courseAssignments.userId, staffId)),
      db
        .select({
          videoTitle: videos.title,
          openedAt: videoWatchSessions.openedAt,
          completed: videoWatchSessions.completed,
          completedAt: videoWatchSessions.completedAt,
        })
        .from(videoWatchSessions)
        .leftJoin(videos, eq(videoWatchSessions.videoId, videos.id))
        .where(eq(videoWatchSessions.userId, staffId)),
      db
        .select({
          videoTitle: videos.title,
          submittedAt: quizAttempts.submittedAt,
          passed: quizAttempts.passed,
          percentage: quizAttempts.percentage,
        })
        .from(quizAttempts)
        .leftJoin(videos, eq(quizAttempts.videoId, videos.id))
        .where(eq(quizAttempts.userId, staffId)),
    ]);

    type TimelineEvent = { type: string; timestamp: string; description: string };
    const events: TimelineEvent[] = [];

    for (const a of assignmentRows) {
      if (!a.assignedAt) continue;
      events.push({
        type: 'course_assigned',
        timestamp: new Date(a.assignedAt).toISOString(),
        description: `Assigned to "${a.sectionTitle || 'a course'}"`,
      });
    }
    for (const s of sessionRows) {
      events.push({
        type: 'video_opened',
        timestamp: new Date(s.openedAt).toISOString(),
        description: `Opened "${s.videoTitle || 'a video'}"`,
      });
      if (s.completed && s.completedAt) {
        events.push({
          type: 'video_completed',
          timestamp: new Date(s.completedAt).toISOString(),
          description: `Completed "${s.videoTitle || 'a video'}"`,
        });
      }
    }
    for (const q of quizRows) {
      events.push({
        type: 'quiz_submitted',
        timestamp: new Date(q.submittedAt).toISOString(),
        description: `${q.passed ? 'Passed' : 'Failed'} quiz for "${q.videoTitle || 'a video'}" (${q.percentage}%)`,
      });
    }

    events.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    const totalCount = events.length;
    const startIdx = (page - 1) * pageSize;
    const pageItems = events.slice(startIdx, startIdx + pageSize);

    res.json({ events: pageItems, page, pageSize, totalCount, totalPages: Math.ceil(totalCount / pageSize) });
  } catch (err: any) {
    sendServerError(res, err, 'Error fetching activity timeline');
  }
});

export default app;
