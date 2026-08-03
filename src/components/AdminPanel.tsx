import React, { useState, useEffect } from "react";
import { Section, Home, User, Video as VideoType, QuizQuestion } from "../types";
import {
  Plus,
  Video,
  Users,
  Building2,
  Trash2,
  Edit,
  AlertCircle,
  CheckCircle2,
  ShieldCheck,
  Youtube,
  Archive,
  ArchiveRestore,
  X,
} from "lucide-react";
import { extractYouTubeVideoId } from "../lib/youtube";
import { ConfirmDialog } from "./ConfirmDialog";

interface AdminPanelProps {
  currentUser: User;
  sections: Section[];
  homes: Home[];
  onRefreshData: () => void;
}

export const AdminPanel: React.FC<AdminPanelProps> = ({ currentUser, sections, homes, onRefreshData }) => {
  const [activeSubTab, setActiveSubTab] = useState<'upload' | 'sections' | 'homes' | 'users'>('upload');

  // Video Upload State
  const [selectedSectionId, setSelectedSectionId] = useState<number>(sections[0]?.id || 1);
  const [isAddingSection, setIsAddingSection] = useState(false);
  const [inlineSectionTitle, setInlineSectionTitle] = useState('');
  const [videoTitle, setVideoTitle] = useState('');
  const [videoDesc, setVideoDesc] = useState('');
  const [videoUrl, setVideoUrl] = useState('');
  const [duration, setDuration] = useState(180);

  // Up to 3 optional quiz questions — an admin may leave all of them blank
  // to publish a video with no quiz at all.
  const [q1Question, setQ1Question] = useState('');
  const [q1Opts, setQ1Opts] = useState(['Ignore alarm', 'Evacuate immediately', 'Wait 1 hour', 'Lock door']);
  const [q1Correct, setQ1Correct] = useState(1);

  const [q2Question, setQ2Question] = useState('');
  const [q2Opts, setQ2Opts] = useState(['Inside kitchen', 'Outside assembly point', 'In parking space', 'In elevator']);
  const [q2Correct, setQ2Correct] = useState(1);

  const [q3Question, setQ3Question] = useState('');
  const [q3Opts, setQ3Opts] = useState(['Every 10 years', 'Regularly per policy', 'Never', 'Once on real fire']);
  const [q3Correct, setQ3Correct] = useState(1);

  const [uploadMsg, setUploadMsg] = useState<string | null>(null);
  const [uploadErr, setUploadErr] = useState<string | null>(null);

  // Home Creation State
  const [newHomeName, setNewHomeName] = useState("");
  const [homeActionMsg, setHomeActionMsg] = useState<string | null>(null);
  const [homeActionErr, setHomeActionErr] = useState<string | null>(null);
  const [homeToDelete, setHomeToDelete] = useState<Home | null>(null);
  const [isDeletingHome, setIsDeletingHome] = useState(false);

  // Section Creation State
  const [newSecTitle, setNewSecTitle] = useState("");
  const [newSecDesc, setNewSecDesc] = useState("");

  // Course/video management state (archive + delete)
  const [courseMsg, setCourseMsg] = useState<string | null>(null);
  const [courseErr, setCourseErr] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [sectionToDelete, setSectionToDelete] = useState<Section | null>(null);
  const [videoToDelete, setVideoToDelete] = useState<{ video: VideoType; sectionTitle: string } | null>(null);
  const [isDeletingCourseItem, setIsDeletingCourseItem] = useState(false);

  // Video edit state — lets an admin change a published video's section,
  // title, URL, and quiz questions after the fact.
  const [editingVideoId, setEditingVideoId] = useState<number | null>(null);
  const [isLoadingEditVideo, setIsLoadingEditVideo] = useState(false);
  const [isSavingVideoEdit, setIsSavingVideoEdit] = useState(false);
  const [editVideoErr, setEditVideoErr] = useState<string | null>(null);
  const [editSectionId, setEditSectionId] = useState<number>(0);
  const [editTitle, setEditTitle] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editUrl, setEditUrl] = useState('');
  const [editQ1, setEditQ1] = useState('');
  const [editQ2, setEditQ2] = useState('');
  const [editQ3, setEditQ3] = useState('');
  // The video's existing quiz questions as loaded from the server, keyed by
  // slot index — used to preserve each question's options/correctIndex when
  // only its wording changes, and as the source for the default option
  // templates when a slot is newly filled in.
  const [editExistingQuestions, setEditExistingQuestions] = useState<QuizQuestion[]>([]);

  // User Management State
  const [allUsers, setAllUsers] = useState<User[]>([]);
  const [newStaffEmail, setNewStaffEmail] = useState("");
  const [newStaffUsername, setNewStaffUsername] = useState("");
  const [newStaffPassword, setNewStaffPassword] = useState("");
  const [newStaffRole, setNewStaffRole] = useState<"staff" | "admin">("staff");
  const [newStaffHomeId, setNewStaffHomeId] = useState<number>(
    homes[0]?.id || 1,
  );
  const [editingUserId, setEditingUserId] = useState<number | null>(null);
  const [editingRole, setEditingRole] = useState<"staff" | "admin">("staff");
  const [editingHomeId, setEditingHomeId] = useState<number>(homes[0]?.id || 1);
  const [userActionMsg, setUserActionMsg] = useState<string | null>(null);
  const [userActionErr, setUserActionErr] = useState<string | null>(null);
  const [userToDelete, setUserToDelete] = useState<User | null>(null);
  const [isDeletingUser, setIsDeletingUser] = useState(false);

  useEffect(() => {
    if (currentUser.role === "admin") {
      fetchUsers();
    }
  }, [currentUser]);

  useEffect(() => {
    if (homes.length > 0) {
      setNewStaffHomeId((current) =>
        current && homes.some((home) => home.id === current)
          ? current
          : homes[0].id,
      );
      setEditingHomeId((current) =>
        current && homes.some((home) => home.id === current)
          ? current
          : homes[0].id,
      );
    }
  }, [homes]);

  if (currentUser.role !== "admin") {
    return (
      <div className="bg-white rounded-[32px] p-8 border border-slate-200 shadow-sm text-center space-y-4">
        <div className="w-16 h-16 bg-rose-100 text-rose-600 rounded-full flex items-center justify-center mx-auto">
          <AlertCircle className="w-8 h-8" />
        </div>
        <h3 className="text-xl font-bold text-slate-900">Access Restricted</h3>
        <p className="text-xs text-slate-500 max-w-md mx-auto">
          Only Administrator accounts have permission to upload training videos,
          create sections, manage workplace homes, or view staff completion
          reports.
        </p>
      </div>
    );
  }

  const fetchUsers = async () => {
    try {
      const res = await fetch("/api/admin/users", {
        credentials: "include",
      });
      if (res.ok) {
        const data = await res.json();
        setAllUsers(data);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const youtubeVideoId = extractYouTubeVideoId(videoUrl);

  const handleUploadVideo = async (e: React.FormEvent) => {
    e.preventDefault();
    setUploadErr(null);
    setUploadMsg(null);

    if (!videoUrl) {
      setUploadErr('Please enter a YouTube video URL.');
      return;
    }
    if (!youtubeVideoId) {
      setUploadErr('That does not look like a valid YouTube URL (e.g. https://www.youtube.com/watch?v=...).');
      return;
    }

    const trimmedNewSectionTitle = inlineSectionTitle.trim();
    if (isAddingSection && !trimmedNewSectionTitle) {
      setUploadErr('Please enter a title for the new section.');
      return;
    }

    // Quiz questions are optional — an admin may publish a video with none,
    // one, two, or all three. Only non-empty question slots are sent.
    const questions = [
      { question: q1Question, options: q1Opts, correctIndex: q1Correct },
      { question: q2Question, options: q2Opts, correctIndex: q2Correct },
      { question: q3Question, options: q3Opts, correctIndex: q3Correct },
    ].filter((q) => q.question.trim() !== '');

    try {
      let sectionId = selectedSectionId;

      if (isAddingSection) {
        const sectionRes = await fetch('/api/sections', {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ title: trimmedNewSectionTitle }),
        });
        const newSection = await sectionRes.json();
        if (!sectionRes.ok) {
          throw new Error(newSection.error || 'Failed to create section');
        }
        sectionId = newSection.id;
      }

      const res = await fetch("/api/videos", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sectionId,
          title: videoTitle,
          description: videoDesc,
          url: `https://www.youtube.com/watch?v=${youtubeVideoId}`,
          durationSeconds: duration,
          questions,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to upload video");

      setUploadMsg(
        questions.length > 0
          ? `Training video module and ${questions.length} quiz question${questions.length === 1 ? '' : 's'} created successfully!`
          : 'Training video module created successfully (no quiz added).'
      );
      setVideoTitle('');
      setVideoDesc('');
      setVideoUrl('');
      if (isAddingSection) {
        setSelectedSectionId(sectionId);
        setIsAddingSection(false);
        setInlineSectionTitle('');
      }
      onRefreshData();
    } catch (err: any) {
      setUploadErr(err.message || "Error creating video module");
    }
  };

  const handleCreateHome = async (e: React.FormEvent) => {
    e.preventDefault();
    setHomeActionErr(null);
    setHomeActionMsg(null);

    const trimmedName = newHomeName.trim();
    if (!trimmedName) {
      setHomeActionErr("Home name is required.");
      return;
    }

    try {
      const res = await fetch("/api/homes", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: trimmedName }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to create home");
      }

      setNewHomeName("");
      setHomeActionMsg(`Home "${trimmedName}" created successfully.`);
      onRefreshData();
    } catch (e: any) {
      console.error(e);
      setHomeActionErr(e?.message || "Error creating home");
    }
  };

  const executeDeleteHome = async () => {
    if (!homeToDelete) return;

    setIsDeletingHome(true);
    setHomeActionErr(null);
    setHomeActionMsg(null);

    try {
      const res = await fetch(`/api/homes/${homeToDelete.id}`, {
        method: "DELETE",
        credentials: "include",
      });

      const text = await res.text();
      let data: any = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = { message: text };
        }
      }

      if (!res.ok) {
        const message = data?.error || data?.message || res.statusText || "Failed to delete home";
        throw new Error(message);
      }

      setHomeActionMsg(data?.message || "Home deleted successfully.");
      setHomeToDelete(null);
      onRefreshData();
    } catch (e: any) {
      console.error(e);
      setHomeActionErr(e?.message || "Error deleting home");
      setHomeToDelete(null);
    } finally {
      setIsDeletingHome(false);
    }
  };

  const handleCreateSection = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newSecTitle) return;
    try {
      const res = await fetch("/api/sections", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ title: newSecTitle, description: newSecDesc }),
      });
      if (res.ok) {
        setNewSecTitle("");
        setNewSecDesc("");
        onRefreshData();
      }
    } catch (e) {
      console.error(e);
    }
  };

  const toggleSectionArchive = async (section: Section) => {
    setCourseErr(null);
    setCourseMsg(null);
    setBusyKey(`section-${section.id}`);
    try {
      const res = await fetch(`/api/sections/${section.id}/archive`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ archived: !section.isArchived }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to update course');
      setCourseMsg(`"${section.title}" was ${section.isArchived ? 'restored' : 'archived'}.`);
      onRefreshData();
    } catch (err: any) {
      setCourseErr(err.message || 'Failed to update course');
    } finally {
      setBusyKey(null);
    }
  };

  const toggleVideoArchive = async (video: VideoType) => {
    setCourseErr(null);
    setCourseMsg(null);
    setBusyKey(`video-${video.id}`);
    try {
      const res = await fetch(`/api/videos/${video.id}/archive`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ archived: !video.isArchived }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to update video');
      setCourseMsg(`"${video.title}" was ${video.isArchived ? 'restored' : 'archived'}.`);
      onRefreshData();
    } catch (err: any) {
      setCourseErr(err.message || 'Failed to update video');
    } finally {
      setBusyKey(null);
    }
  };

  const executeDeleteSection = async () => {
    if (!sectionToDelete) return;
    setIsDeletingCourseItem(true);
    setCourseErr(null);
    setCourseMsg(null);
    try {
      const res = await fetch(`/api/sections/${sectionToDelete.id}`, { method: 'DELETE', credentials: 'include' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to delete course');
      setCourseMsg(data.message);
      setSectionToDelete(null);
      onRefreshData();
    } catch (err: any) {
      setCourseErr(err.message || 'Failed to delete course');
      setSectionToDelete(null);
    } finally {
      setIsDeletingCourseItem(false);
    }
  };

  const executeDeleteVideo = async () => {
    if (!videoToDelete) return;
    setIsDeletingCourseItem(true);
    setCourseErr(null);
    setCourseMsg(null);
    try {
      const res = await fetch(`/api/videos/${videoToDelete.video.id}`, { method: 'DELETE', credentials: 'include' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to delete video');
      setCourseMsg(data.message);
      setVideoToDelete(null);
      onRefreshData();
    } catch (err: any) {
      setCourseErr(err.message || 'Failed to delete video');
      setVideoToDelete(null);
    } finally {
      setIsDeletingCourseItem(false);
    }
  };

  const startEditVideo = async (video: VideoType) => {
    setEditVideoErr(null);
    setEditingVideoId(video.id);
    setIsLoadingEditVideo(true);
    setEditSectionId(video.sectionId);
    setEditTitle(video.title);
    setEditDescription(video.description || '');
    setEditUrl(video.url);
    setEditQ1('');
    setEditQ2('');
    setEditQ3('');
    setEditExistingQuestions([]);

    try {
      const res = await fetch(`/api/videos/${video.id}`, { credentials: 'include' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load video details');

      const existing: QuizQuestion[] = data.quizQuestions || [];
      setEditExistingQuestions(existing);
      setEditQ1(existing[0]?.question || '');
      setEditQ2(existing[1]?.question || '');
      setEditQ3(existing[2]?.question || '');
    } catch (err: any) {
      setEditVideoErr(err.message || 'Failed to load video details');
    } finally {
      setIsLoadingEditVideo(false);
    }
  };

  const cancelEditVideo = () => {
    setEditingVideoId(null);
    setEditVideoErr(null);
  };

  const handleSaveVideoEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingVideoId) return;
    setEditVideoErr(null);

    const defaultOptsBySlot = [
      { options: ['Ignore alarm', 'Evacuate immediately', 'Wait 1 hour', 'Lock door'], correctIndex: 1 },
      { options: ['Inside kitchen', 'Outside assembly point', 'In parking space', 'In elevator'], correctIndex: 1 },
      { options: ['Every 10 years', 'Regularly per policy', 'Never', 'Once on real fire'], correctIndex: 1 },
    ];

    // Each slot's options/correctIndex carry over from the question that was
    // already there (so editing wording doesn't discard the answer key); a
    // newly-filled slot falls back to the same canned template the "add
    // video" form uses.
    const questions = [editQ1, editQ2, editQ3]
      .map((questionText, idx) => {
        const trimmed = questionText.trim();
        if (!trimmed) return null;
        const existing = editExistingQuestions[idx];
        const template = defaultOptsBySlot[idx];
        return {
          question: trimmed,
          options: existing?.options || template.options,
          correctIndex: existing?.correctIndex ?? template.correctIndex,
          explanation: existing?.explanation || '',
        };
      })
      .filter((q): q is NonNullable<typeof q> => q !== null);

    setIsSavingVideoEdit(true);
    try {
      const res = await fetch(`/api/videos/${editingVideoId}`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sectionId: editSectionId,
          title: editTitle,
          description: editDescription,
          url: editUrl,
          questions,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save changes');

      setCourseMsg(`"${editTitle}" was updated successfully.`);
      setEditingVideoId(null);
      onRefreshData();
    } catch (err: any) {
      setEditVideoErr(err.message || 'Failed to save changes');
    } finally {
      setIsSavingVideoEdit(false);
    }
  };

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setUserActionErr(null);
    setUserActionMsg(null);

    if (!newStaffEmail || !newStaffUsername || !newStaffPassword) {
      setUserActionErr("Email, Username, and Password are required.");
      return;
    }
    if (newStaffPassword.length < 8) {
      setUserActionErr("Password must be at least 8 characters.");
      return;
    }

    try {
      const res = await fetch("/api/admin/users", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email: newStaffEmail,
          username: newStaffUsername,
          password: newStaffPassword,
          role: newStaffRole,
          homeId: newStaffHomeId,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to create user");
      }

      setUserActionMsg(
        `New ${newStaffRole.toUpperCase()} account created for ${newStaffUsername}. They'll be asked to choose their own password the first time they log in.`,
      );
      setNewStaffEmail("");
      setNewStaffUsername("");
      setNewStaffPassword("");
      fetchUsers();
    } catch (e: any) {
      setUserActionErr(e.message || "Error creating user account");
    }
  };

  const startEditUser = (u: User) => {
    setEditingUserId(u.id);
    setEditingRole(u.role);
    setEditingHomeId(u.homeId ?? homes[0]?.id ?? 1);
    setUserActionErr(null);
    setUserActionMsg(null);
  };

  const handleUpdateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingUserId) return;

    setUserActionErr(null);
    setUserActionMsg(null);

    try {
      const res = await fetch(`/api/admin/users/${editingUserId}`, {
        method: "PUT",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          role: editingRole,
          homeId: editingHomeId,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to update user");

      setUserActionMsg(
        `Updated ${editingRole.toUpperCase()} assignment for the selected account.`,
      );
      setEditingUserId(null);
      fetchUsers();
    } catch (e: any) {
      setUserActionErr(e.message || "Error updating user account");
    }
  };

  const promptDeleteUser = (u: User) => {
    setUserActionErr(null);
    setUserActionMsg(null);

    if (u.id === currentUser.id) {
      setUserActionErr("You cannot delete your own active admin account!");
      return;
    }

    setUserToDelete(u);
  };

  const executeDeleteUser = async () => {
    if (!userToDelete) return;

    setIsDeletingUser(true);
    setUserActionErr(null);
    setUserActionMsg(null);

    try {
      const res = await fetch(`/api/admin/users/${userToDelete.id}`, {
        method: "DELETE",
        credentials: "include",
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to delete user");
      }

      setUserActionMsg(
        `User "${userToDelete.username}" (${userToDelete.role}) was deleted successfully.`,
      );
      setUserToDelete(null);
      fetchUsers();
    } catch (e: any) {
      setUserActionErr(e.message || "Error deleting user");
      setUserToDelete(null);
    } finally {
      setIsDeletingUser(false);
    }
  };

  return (
    <div className="space-y-6 select-none">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-slate-900 tracking-tight flex items-center gap-2">
            <ShieldCheck className="w-6 h-6 text-indigo-600" />
            Course & Staff Management
          </h2>
          <p className="text-xs text-slate-500 mt-1">
            Add YouTube training videos, manage courses and staff/admin accounts, and organize workplace homes.
          </p>
        </div>
      </div>

      {/* Admin Sub-Tabs */}
      <div className="flex overflow-x-auto bg-white p-1.5 rounded-2xl border border-slate-200 shadow-sm gap-1 scrollbar-none">
        <button
          onClick={() => setActiveSubTab("upload")}
          className={`px-3.5 py-2 rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-1.5 shrink-0 sm:flex-1 ${
            activeSubTab === "upload"
              ? "bg-indigo-600 text-white shadow-md"
              : "text-slate-600 hover:text-slate-900"
          }`}
        >
          <Video className="w-3.5 h-3.5 shrink-0" /> Upload Video
        </button>
        <button
          onClick={() => setActiveSubTab("sections")}
          className={`px-3.5 py-2 rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-1.5 shrink-0 sm:flex-1 ${
            activeSubTab === "sections"
              ? "bg-indigo-600 text-white shadow-md"
              : "text-slate-600 hover:text-slate-900"
          }`}
        >
          <Plus className="w-3.5 h-3.5 shrink-0" /> Courses & Videos
        </button>
        <button
          onClick={() => setActiveSubTab("homes")}
          className={`px-3.5 py-2 rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-1.5 shrink-0 sm:flex-1 ${
            activeSubTab === "homes"
              ? "bg-indigo-600 text-white shadow-md"
              : "text-slate-600 hover:text-slate-900"
          }`}
        >
          <Building2 className="w-3.5 h-3.5 shrink-0" /> Homes
        </button>
        <button
          onClick={() => setActiveSubTab("users")}
          className={`px-3.5 py-2 rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-1.5 shrink-0 sm:flex-1 ${
            activeSubTab === "users"
              ? "bg-indigo-600 text-white shadow-md"
              : "text-slate-600 hover:text-slate-900"
          }`}
        >
          <Users className="w-3.5 h-3.5 shrink-0" /> Staff & Admins
        </button>
      </div>

      {/* 1. UPLOAD VIDEO MODULE FORM */}
      {activeSubTab === "upload" && (
        <form
          onSubmit={handleUploadVideo}
          className="bg-white rounded-[24px] sm:rounded-[32px] p-4 sm:p-6 md:p-8 border border-slate-200 shadow-sm space-y-6"
        >
          <h3 className="text-lg font-bold text-slate-900 border-b border-slate-100 pb-3">
            Add New Training Video
          </h3>

          {uploadMsg && (
            <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-2xl text-emerald-700 text-xs font-medium flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4" /> {uploadMsg}
            </div>
          )}
          {uploadErr && (
            <div className="p-3 bg-rose-50 border border-rose-200 rounded-2xl text-rose-700 text-xs font-medium flex items-center gap-2">
              <AlertCircle className="w-4 h-4" /> {uploadErr}
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-bold text-slate-700 uppercase mb-1">
                Section Title
              </label>
              {isAddingSection ? (
                <input
                  type="text"
                  required
                  autoFocus
                  placeholder="New section title, e.g. Fire Safety"
                  value={inlineSectionTitle}
                  onChange={(e) => setInlineSectionTitle(e.target.value)}
                  className="w-full px-4 py-2.5 rounded-2xl bg-slate-50 border border-slate-200 text-sm font-semibold text-slate-900"
                />
              ) : (
                <select
                  value={selectedSectionId}
                  onChange={(e) => {
                    if (e.target.value === "__new__") {
                      setIsAddingSection(true);
                    } else {
                      setSelectedSectionId(parseInt(e.target.value, 10));
                    }
                  }}
                  className="w-full px-4 py-2.5 rounded-2xl bg-slate-50 border border-slate-200 text-sm font-semibold text-slate-900"
                >
                  {sections.filter((s) => !s.isArchived).map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.title}
                    </option>
                  ))}
                  <option value="__new__">+ Add New Section...</option>
                </select>
              )}
              {isAddingSection && (
                <button
                  type="button"
                  onClick={() => {
                    setIsAddingSection(false);
                    setInlineSectionTitle("");
                  }}
                  className="mt-1 text-[11px] font-bold text-indigo-600 hover:text-indigo-700"
                >
                  Choose an existing section instead
                </button>
              )}
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-700 uppercase mb-1">
                Video Title
              </label>
              <input
                type="text"
                required
                value={videoTitle}
                onChange={(e) => setVideoTitle(e.target.value)}
                placeholder="e.g. Infection Control Standards"
                className="w-full px-4 py-2.5 rounded-2xl bg-slate-50 border border-slate-200 text-sm font-semibold text-slate-900"
              />
            </div>
          </div>

          {/* YouTube Video Source */}
          <div className="p-5 bg-slate-50 rounded-2xl border border-slate-200 space-y-4">
            <label className="text-xs font-bold text-slate-800 uppercase tracking-wider flex items-center gap-2">
              <Youtube className="w-4 h-4 text-indigo-600" /> YouTube Video URL
            </label>

            <input
              type="url"
              required
              value={videoUrl}
              onChange={(e) => setVideoUrl(e.target.value)}
              placeholder="https://www.youtube.com/watch?v=... or https://youtu.be/..."
              className="w-full px-4 py-2.5 rounded-2xl bg-white border border-slate-200 text-xs font-mono text-slate-900"
            />
            {videoUrl && !youtubeVideoId && (
              <p className="text-xs text-rose-600 font-medium">
                That doesn't look like a valid YouTube link yet.
              </p>
            )}
            <p className="text-xs text-slate-500">
              Paste a link to a public or unlisted YouTube video. Staff will watch it directly on this page,
              and their watch progress is tracked automatically.
            </p>

            {/* Preview */}
            {youtubeVideoId && (
              <div className="space-y-2 pt-2 border-t border-slate-200">
                <span className="text-xs font-bold text-slate-600">Preview</span>
                <div className="rounded-2xl overflow-hidden bg-slate-950 aspect-video max-h-56 flex items-center justify-center border border-slate-800">
                  <img
                    src={`https://img.youtube.com/vi/${youtubeVideoId}/hqdefault.jpg`}
                    alt="YouTube video thumbnail"
                    className="w-full h-full object-contain"
                  />
                </div>
              </div>
            )}
          </div>

          <div className="pt-4 border-t border-slate-100 space-y-4">
            <div>
              <h4 className="font-bold text-sm text-slate-800">Quiz Questions (Optional)</h4>
              <p className="text-xs text-slate-500 mt-0.5">
                Add up to 3 questions, or leave all of them blank to publish this video without a quiz.
                Staff need at least 2/3 correct to pass when a quiz is added.
              </p>
            </div>

            {/* Q1 */}
            <div className="p-4 bg-slate-50 rounded-2xl border border-slate-200 space-y-2">
              <label className="block text-xs font-bold text-indigo-600 uppercase">Question 1 (optional)</label>
              <input
                type="text"
                value={q1Question}
                onChange={(e) => setQ1Question(e.target.value)}
                placeholder="Leave blank to skip"
                className="w-full px-3 py-2 bg-white rounded-xl border border-slate-200 text-xs font-medium text-slate-900"
              />
            </div>

            {/* Q2 */}
            <div className="p-4 bg-slate-50 rounded-2xl border border-slate-200 space-y-2">
              <label className="block text-xs font-bold text-indigo-600 uppercase">Question 2 (optional)</label>
              <input
                type="text"
                value={q2Question}
                onChange={(e) => setQ2Question(e.target.value)}
                placeholder="Leave blank to skip"
                className="w-full px-3 py-2 bg-white rounded-xl border border-slate-200 text-xs font-medium text-slate-900"
              />
            </div>

            {/* Q3 */}
            <div className="p-4 bg-slate-50 rounded-2xl border border-slate-200 space-y-2">
              <label className="block text-xs font-bold text-indigo-600 uppercase">Question 3 (optional)</label>
              <input
                type="text"
                value={q3Question}
                onChange={(e) => setQ3Question(e.target.value)}
                placeholder="Leave blank to skip"
                className="w-full px-3 py-2 bg-white rounded-xl border border-slate-200 text-xs font-medium text-slate-900"
              />
            </div>
          </div>

          <button
            type="submit"
            className="w-full py-3.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-2xl font-bold text-sm shadow-xl shadow-indigo-200 transition-all flex items-center justify-center gap-2"
          >
            Publish Training Video Module
          </button>
        </form>
      )}

      {/* 2. COURSES & VIDEOS MANAGEMENT */}
      {activeSubTab === 'sections' && (
        <div className="bg-white rounded-[24px] sm:rounded-[32px] p-4 sm:p-6 md:p-8 border border-slate-200 shadow-sm space-y-6">
          <h3 className="text-lg font-bold text-slate-900 border-b border-slate-100 pb-3">
            Add Training Section/Title
          </h3>
          <form
            onSubmit={handleCreateSection}
            className="flex flex-col sm:flex-row gap-2"
          >
            <input
              type="text"
              placeholder="e.g. Hygiene & Medication Safety"
              value={newSecTitle}
              onChange={(e) => setNewSecTitle(e.target.value)}
              className="flex-1 px-4 py-2.5 rounded-2xl bg-slate-50 border border-slate-200 text-sm text-slate-900"
            />
            <button
              type="submit"
              className="px-6 py-2.5 bg-indigo-600 text-white font-bold rounded-2xl text-xs shadow-md shadow-indigo-200 shrink-0"
            >
              Add Section
            </button>
          </form>

          {courseMsg && (
            <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-2xl text-emerald-700 text-xs font-medium flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 shrink-0" /> {courseMsg}
            </div>
          )}
          {courseErr && (
            <div className="p-3 bg-rose-50 border border-rose-200 rounded-2xl text-rose-700 text-xs font-medium flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" /> {courseErr}
            </div>
          )}

          <div className="space-y-3 pt-4">
            {sections.map((s) => (
              <div
                key={s.id}
                className={`p-4 rounded-2xl border ${
                  s.isArchived ? 'bg-slate-100 border-slate-200 opacity-75' : 'bg-slate-50 border-slate-200'
                }`}
              >
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div>
                    <h4 className="font-bold text-slate-800 text-sm flex items-center gap-2">
                      {s.title}
                      {s.isArchived && (
                        <span className="text-[10px] font-bold uppercase bg-slate-300 text-slate-700 px-2 py-0.5 rounded-full">
                          Archived
                        </span>
                      )}
                    </h4>
                    <p className="text-xs text-slate-500">{s.videos.length} video{s.videos.length === 1 ? '' : 's'}</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => toggleSectionArchive(s)}
                      disabled={busyKey === `section-${s.id}`}
                      className="px-3 py-1.5 bg-white border border-slate-200 rounded-xl text-xs font-bold text-slate-600 hover:bg-slate-100 disabled:opacity-50 transition-all flex items-center gap-1.5"
                    >
                      {s.isArchived ? <ArchiveRestore className="w-3.5 h-3.5" /> : <Archive className="w-3.5 h-3.5" />}
                      {s.isArchived ? 'Restore' : 'Archive'}
                    </button>
                    <button
                      onClick={() => setSectionToDelete(s)}
                      className="p-2 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-xl transition-colors"
                      title="Delete course"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                {s.videos.length > 0 && (
                  <div className="mt-3 pt-3 border-t border-slate-200/70 space-y-2">
                    {s.videos.map((v) => (
                      <div
                        key={v.id}
                        className={`flex items-center justify-between p-2.5 rounded-xl border ${
                          v.isArchived ? 'bg-slate-50 border-slate-100 opacity-70' : 'bg-white border-slate-100'
                        }`}
                      >
                        <p className="text-xs font-semibold text-slate-700 truncate flex items-center gap-1.5">
                          {v.title}
                          {v.isArchived && (
                            <span className="text-[9px] font-bold uppercase bg-slate-200 text-slate-600 px-1.5 py-0.5 rounded-full shrink-0">
                              Archived
                            </span>
                          )}
                        </p>
                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            onClick={() => startEditVideo(v)}
                            className="p-1.5 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors"
                            title="Edit video"
                          >
                            <Edit className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => toggleVideoArchive(v)}
                            disabled={busyKey === `video-${v.id}`}
                            className="px-2.5 py-1 bg-slate-50 border border-slate-200 rounded-lg text-[11px] font-bold text-slate-600 hover:bg-slate-100 disabled:opacity-50 transition-all"
                          >
                            {v.isArchived ? 'Restore' : 'Archive'}
                          </button>
                          <button
                            onClick={() => setVideoToDelete({ video: v, sectionTitle: s.title })}
                            className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-colors"
                            title="Delete video"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 3. HOMES LOCATION MANAGEMENT */}
      {activeSubTab === "homes" && (
        <div className="bg-white rounded-[24px] sm:rounded-[32px] p-4 sm:p-6 md:p-8 border border-slate-200 shadow-sm space-y-6">
          <h3 className="text-lg font-bold text-slate-900 border-b border-slate-100 pb-3">
            Manage Workplace Homes
          </h3>
          <p className="text-xs text-slate-500">
            Add new home locations and manage the existing workplace homes.
          </p>
          <form onSubmit={handleCreateHome} className="flex flex-col sm:flex-row gap-3 sm:items-center">
            <input
              type="text"
              placeholder="New Home Name (e.g. Grace Home)"
              value={newHomeName}
              onChange={(e) => setNewHomeName(e.target.value)}
              className="flex-1 w-full px-4 py-2.5 rounded-2xl bg-slate-50 border border-slate-200 text-sm text-slate-900"
            />
            <button
              type="submit"
              className="px-6 py-2.5 bg-indigo-600 text-white font-bold rounded-2xl text-xs shadow-md shadow-indigo-200 shrink-0"
            >
              Add Home
            </button>
          </form>

          {homeActionMsg && (
            <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-2xl text-emerald-700 text-xs font-medium flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 shrink-0" /> {homeActionMsg}
            </div>
          )}
          {homeActionErr && (
            <div className="p-3 bg-rose-50 border border-rose-200 rounded-2xl text-rose-700 text-xs font-medium flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" /> {homeActionErr}
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-4">
            {homes.map((h) => (
              <div
                key={h.id}
                className="p-5 bg-slate-50 rounded-2xl border border-slate-200 flex items-center gap-3 justify-between"
              >
                <div className="flex items-center gap-3">
                  <Building2 className="w-6 h-6 text-indigo-600 shrink-0" />
                  <div>
                    <h4 className="font-bold text-slate-800 text-sm">{h.name}</h4>
                    <span className="text-[10px] font-mono font-bold bg-slate-200 px-2 py-0.5 rounded text-slate-600">
                      CODE: {h.code}
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setHomeToDelete(h)}
                  className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-500 transition hover:bg-slate-100 hover:text-rose-600 shrink-0"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 4. USER / STAFF & ADMIN MANAGEMENT */}
      {activeSubTab === "users" && (
        <div className="bg-white rounded-[24px] sm:rounded-[32px] p-4 sm:p-6 md:p-8 border border-slate-200 shadow-sm space-y-6">
          <div className="flex items-center justify-between border-b border-slate-100 pb-3">
            <div>
              <h3 className="text-lg font-bold text-slate-900">
                Manage Staff & Admin Accounts
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                Add new staff or admin users, assign workplace locations, or
                delete existing user accounts.
              </p>
            </div>
          </div>

          {userActionMsg && (
            <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-2xl text-emerald-700 text-xs font-medium flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4" /> {userActionMsg}
            </div>
          )}
          {userActionErr && (
            <div className="p-3 bg-rose-50 border border-rose-200 rounded-2xl text-rose-700 text-xs font-medium flex items-center gap-2">
              <AlertCircle className="w-4 h-4" /> {userActionErr}
            </div>
          )}

          {/* Add User Form */}
          <form
            onSubmit={handleCreateUser}
            className="p-5 bg-slate-50 rounded-2xl border border-slate-200 space-y-4"
          >
            <h4 className="font-bold text-slate-800 text-xs uppercase tracking-wider">
              Create New User Account
            </h4>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              <div>
                <label className="block text-[11px] font-bold text-slate-600 uppercase mb-1">
                  Email
                </label>
                <input
                  type="email"
                  required
                  placeholder="e.g. sami@videotrain.com"
                  value={newStaffEmail}
                  onChange={(e) => setNewStaffEmail(e.target.value)}
                  className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-xs font-medium text-slate-900"
                />
              </div>

              <div>
                <label className="block text-[11px] font-bold text-slate-600 uppercase mb-1">
                  Username
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. staff_sami"
                  value={newStaffUsername}
                  onChange={(e) => setNewStaffUsername(e.target.value)}
                  className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-xs font-medium text-slate-900"
                />
              </div>

              <div>
                <label className="block text-[11px] font-bold text-slate-600 uppercase mb-1">
                  Initial Password
                </label>
                <input
                  type="text"
                  required
                  minLength={8}
                  placeholder="At least 8 characters"
                  value={newStaffPassword}
                  onChange={(e) => setNewStaffPassword(e.target.value)}
                  className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-xs font-mono text-slate-900"
                />
              </div>

              <div>
                <label className="block text-[11px] font-bold text-slate-600 uppercase mb-1">
                  Account Role
                </label>
                <select
                  value={newStaffRole}
                  onChange={(e) =>
                    setNewStaffRole(e.target.value as "staff" | "admin")
                  }
                  className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-xs font-bold text-indigo-700"
                >
                  <option value="staff">STAFF (Learning Access)</option>
                  <option value="admin">ADMIN (Full Admin Access)</option>
                </select>
              </div>

              <div>
                <label className="block text-[11px] font-bold text-slate-600 uppercase mb-1">
                  Assigned Location
                </label>
                <select
                  value={newStaffHomeId}
                  onChange={(e) =>
                    setNewStaffHomeId(parseInt(e.target.value, 10))
                  }
                  className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-xs font-medium text-slate-900"
                >
                  {homes.map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex items-end">
                <button
                  type="submit"
                  className="w-full py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-bold rounded-xl text-xs shadow-md shadow-indigo-200 transition-all flex items-center justify-center gap-1.5"
                >
                  <Plus className="w-4 h-4" /> Add User Account
                </button>
              </div>
            </div>
            <p className="text-[11px] text-slate-500">
              The user will be required to set their own password the first time
              they log in with this one.
            </p>
          </form>

          {/* User List */}
          <div className="space-y-3 pt-2">
            <h4 className="font-bold text-slate-800 text-xs uppercase tracking-wider">
              Registered Accounts ({allUsers.length})
            </h4>

            {allUsers.map((u) => {
              const isSelf = u.id === currentUser.id;
              const isAdminRole = u.role === "admin";

              return (
                <div
                  key={u.id}
                  className={`p-4 rounded-2xl border flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 transition-all ${
                    isAdminRole
                      ? "bg-indigo-50/50 border-indigo-200"
                      : "bg-slate-50 border-slate-200"
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <div
                      className={`w-10 h-10 rounded-2xl font-bold flex items-center justify-center text-xs shrink-0 ${
                        isAdminRole
                          ? "bg-indigo-600 text-white shadow-md shadow-indigo-200"
                          : "bg-slate-200 text-slate-700"
                      }`}
                    >
                      {isAdminRole ? (
                        <ShieldCheck className="w-5 h-5" />
                      ) : (
                        <Users className="w-5 h-5" />
                      )}
                    </div>

                    <div>
                      <div className="flex items-center gap-2">
                        <p className="font-bold text-sm text-slate-900">
                          {u.username}
                        </p>
                        <span className="text-xs text-slate-500">
                          ({u.email})
                        </span>
                      </div>

                      <div className="flex items-center gap-2 mt-1">
                        <span
                          className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-md ${
                            isAdminRole
                              ? "bg-indigo-600 text-white font-mono"
                              : "bg-slate-200 text-slate-700 font-mono"
                          }`}
                        >
                          {u.role}
                        </span>
                        <span className="text-xs text-slate-500">
                          Home:{" "}
                          <strong className="text-slate-800">
                            {u.homeName || "Unassigned"}
                          </strong>
                        </span>
                        {u.mustChangePassword && (
                          <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-md bg-amber-100 text-amber-700">
                            Awaiting first login
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="shrink-0 flex flex-wrap items-center gap-2">
                    {editingUserId === u.id ? (
                      <form
                        onSubmit={handleUpdateUser}
                        className="flex flex-wrap items-center gap-2"
                      >
                        <select
                          value={editingRole}
                          onChange={(e) =>
                            setEditingRole(e.target.value as "staff" | "admin")
                          }
                          className="px-2.5 py-1.5 bg-white border border-slate-200 rounded-lg text-[11px] font-bold text-indigo-700"
                        >
                          <option value="staff">STAFF</option>
                          <option value="admin">ADMIN</option>
                        </select>
                        <select
                          value={editingHomeId}
                          onChange={(e) =>
                            setEditingHomeId(parseInt(e.target.value, 10))
                          }
                          className="px-2.5 py-1.5 bg-white border border-slate-200 rounded-lg text-[11px] font-medium text-slate-900"
                        >
                          {homes.map((home) => (
                            <option key={home.id} value={home.id}>
                              {home.name}
                            </option>
                          ))}
                        </select>
                        <button
                          type="submit"
                          className="px-3 py-1.5 bg-indigo-600 text-white rounded-xl text-xs font-bold"
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditingUserId(null)}
                          className="px-3 py-1.5 bg-white text-slate-600 border border-slate-200 rounded-xl text-xs font-bold"
                        >
                          Cancel
                        </button>
                      </form>
                    ) : (
                      <>
                        {!isSelf && (
                          <button
                            onClick={() => startEditUser(u)}
                            className="px-3 py-1.5 bg-white hover:bg-indigo-50 text-indigo-600 hover:text-indigo-700 border border-slate-200 hover:border-indigo-200 rounded-xl text-xs font-bold transition-all shadow-sm flex items-center gap-1.5"
                          >
                            <Edit className="w-3.5 h-3.5" /> Edit
                          </button>
                        )}
                        {isSelf ? (
                          <span className="px-3 py-1.5 bg-slate-200/80 text-slate-600 rounded-xl text-xs font-bold flex items-center gap-1">
                            <ShieldCheck className="w-3.5 h-3.5 text-indigo-600" />{" "}
                            Active Session
                          </span>
                        ) : (
                          <button
                            onClick={() => promptDeleteUser(u)}
                            className="px-3 py-1.5 bg-white hover:bg-rose-50 text-rose-600 hover:text-rose-700 border border-slate-200 hover:border-rose-200 rounded-xl text-xs font-bold transition-all shadow-sm flex items-center gap-1.5"
                          >
                            <Trash2 className="w-3.5 h-3.5" /> Delete{" "}
                            {isAdminRole ? "Admin" : "Staff"}
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* DELETE USER CONFIRMATION MODAL */}
      {userToDelete && (
        <ConfirmDialog
          title="Confirm User Deletion"
          description={`Are you sure you want to permanently delete the ${userToDelete.role.toUpperCase()} account for ${userToDelete.username} (${userToDelete.email})?`}
          warning="All training progress data associated with this user will be deleted permanently."
          confirmLabel="Yes, Delete Account"
          loadingLabel="Deleting Account..."
          isLoading={isDeletingUser}
          onConfirm={executeDeleteUser}
          onCancel={() => setUserToDelete(null)}
        />
      )}

      {/* DELETE COURSE CONFIRMATION MODAL */}
      {sectionToDelete && (
        <ConfirmDialog
          title="Delete course?"
          description={`Delete "${sectionToDelete.title}" and all of its videos?`}
          warning="If any staff member has activity on this course (assignments, watch history, or quiz attempts), it will be archived instead of deleted so their records are preserved."
          confirmLabel="Delete Course"
          loadingLabel="Deleting..."
          isLoading={isDeletingCourseItem}
          onConfirm={executeDeleteSection}
          onCancel={() => setSectionToDelete(null)}
        />
      )}

      {/* DELETE VIDEO CONFIRMATION MODAL */}
      {videoToDelete && (
        <ConfirmDialog
          title="Delete video?"
          description={`Delete "${videoToDelete.video.title}" from "${videoToDelete.sectionTitle}"?`}
          warning="If any staff member has watch or quiz history on this video, it will be archived instead of deleted so their records are preserved."
          confirmLabel="Delete Video"
          loadingLabel="Deleting..."
          isLoading={isDeletingCourseItem}
          onConfirm={executeDeleteVideo}
          onCancel={() => setVideoToDelete(null)}
        />
      )}

      {/* EDIT VIDEO MODAL */}
      {editingVideoId !== null && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto">
          <form
            onSubmit={handleSaveVideoEdit}
            className="bg-white rounded-[28px] max-w-2xl w-full my-8 p-6 shadow-2xl space-y-4 border border-slate-100"
          >
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <h3 className="text-lg font-bold text-slate-900">Edit Training Video</h3>
              <button
                type="button"
                onClick={cancelEditVideo}
                className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-xl transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {isLoadingEditVideo ? (
              <p className="text-sm text-slate-500 py-8 text-center">Loading video details…</p>
            ) : (
              <>
                {editVideoErr && (
                  <div className="p-3 bg-rose-50 border border-rose-200 rounded-2xl text-rose-700 text-xs font-medium flex items-center gap-2">
                    <AlertCircle className="w-4 h-4 shrink-0" /> {editVideoErr}
                  </div>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-bold text-slate-700 uppercase mb-1">Section</label>
                    <select
                      value={editSectionId}
                      onChange={(e) => setEditSectionId(parseInt(e.target.value, 10))}
                      className="w-full px-4 py-2.5 rounded-2xl bg-slate-50 border border-slate-200 text-sm font-semibold text-slate-900"
                    >
                      {sections.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.title}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-slate-700 uppercase mb-1">Video Title</label>
                    <input
                      type="text"
                      required
                      value={editTitle}
                      onChange={(e) => setEditTitle(e.target.value)}
                      className="w-full px-4 py-2.5 rounded-2xl bg-slate-50 border border-slate-200 text-sm font-semibold text-slate-900"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-700 uppercase mb-1">YouTube Video URL</label>
                  <input
                    type="url"
                    required
                    value={editUrl}
                    onChange={(e) => setEditUrl(e.target.value)}
                    className="w-full px-4 py-2.5 rounded-2xl bg-white border border-slate-200 text-xs font-mono text-slate-900"
                  />
                </div>

                <div className="pt-2 border-t border-slate-100 space-y-3">
                  <div>
                    <h4 className="font-bold text-sm text-slate-800">Quiz Questions (Optional)</h4>
                    <p className="text-xs text-slate-500 mt-0.5">
                      Add up to 3 questions, or leave all of them blank to remove the quiz from this video.
                    </p>
                  </div>

                  <div className="p-3 bg-slate-50 rounded-2xl border border-slate-200 space-y-2">
                    <label className="block text-xs font-bold text-indigo-600 uppercase">Question 1 (optional)</label>
                    <input
                      type="text"
                      value={editQ1}
                      onChange={(e) => setEditQ1(e.target.value)}
                      placeholder="Leave blank to skip"
                      className="w-full px-3 py-2 bg-white rounded-xl border border-slate-200 text-xs font-medium text-slate-900"
                    />
                  </div>
                  <div className="p-3 bg-slate-50 rounded-2xl border border-slate-200 space-y-2">
                    <label className="block text-xs font-bold text-indigo-600 uppercase">Question 2 (optional)</label>
                    <input
                      type="text"
                      value={editQ2}
                      onChange={(e) => setEditQ2(e.target.value)}
                      placeholder="Leave blank to skip"
                      className="w-full px-3 py-2 bg-white rounded-xl border border-slate-200 text-xs font-medium text-slate-900"
                    />
                  </div>
                  <div className="p-3 bg-slate-50 rounded-2xl border border-slate-200 space-y-2">
                    <label className="block text-xs font-bold text-indigo-600 uppercase">Question 3 (optional)</label>
                    <input
                      type="text"
                      value={editQ3}
                      onChange={(e) => setEditQ3(e.target.value)}
                      placeholder="Leave blank to skip"
                      className="w-full px-3 py-2 bg-white rounded-xl border border-slate-200 text-xs font-medium text-slate-900"
                    />
                  </div>
                </div>

                <div className="flex items-center justify-end gap-2.5 pt-2">
                  <button
                    type="button"
                    disabled={isSavingVideoEdit}
                    onClick={cancelEditVideo}
                    className="px-4 py-2.5 rounded-xl text-xs font-bold bg-slate-100 hover:bg-slate-200 text-slate-700 transition-all disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={isSavingVideoEdit}
                    className="px-5 py-2.5 rounded-xl text-xs font-bold bg-indigo-600 hover:bg-indigo-700 text-white shadow-lg shadow-indigo-200 transition-all disabled:opacity-60"
                  >
                    {isSavingVideoEdit ? 'Saving...' : 'Save Changes'}
                  </button>
                </div>
              </>
            )}
          </form>
        </div>
      )}

      {/* DELETE HOME CONFIRMATION MODAL */}
      {homeToDelete && (
        <ConfirmDialog
          title="Delete home?"
          description={`This will permanently remove "${homeToDelete.name}".`}
          warning="If any staff members are still assigned to this home, deletion will fail until those assignments are updated."
          confirmLabel="Delete Home"
          loadingLabel="Deleting..."
          isLoading={isDeletingHome}
          onConfirm={executeDeleteHome}
          onCancel={() => setHomeToDelete(null)}
        />
      )}
    </div>
  );
};
