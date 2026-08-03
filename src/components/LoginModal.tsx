import React, { useState, useEffect } from "react";
import { Home, User } from "../types";
import {
  Building2,
  KeyRound,
  Shield,
  UserCheck,
  AlertCircle,
  CheckCircle2,
  Lock,
  Mail,
} from "lucide-react";

interface LoginModalProps {
  onLoginSuccess: (user: User) => void;
  homes: Home[];
}

type View = "login" | "forgot" | "forceChange";

export const LoginModal: React.FC<LoginModalProps> = ({
  onLoginSuccess,
  homes,
}) => {
  const [view, setView] = useState<View>("login");
  const [role, setRole] = useState<"staff" | "admin">("staff");
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [selectedHomeId, setSelectedHomeId] = useState<number>(1);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Forced first-login password change state
  const [changeToken, setChangeToken] = useState<string | null>(null);
  const [forceNewPassword, setForceNewPassword] = useState("");
  const [forceConfirmPassword, setForceConfirmPassword] = useState("");
  const [forceLoading, setForceLoading] = useState(false);

  // Forgot password state
  const [otpStep, setOtpStep] = useState<"request" | "reset">("request");
  const [otpEmail, setOtpEmail] = useState("");
  const [enteredOtp, setEnteredOtp] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [otpSuccessMsg, setOtpSuccessMsg] = useState<string | null>(null);
  const [otpLoading, setOtpLoading] = useState(false);

  useEffect(() => {
    if (homes.length > 0) {
      setSelectedHomeId(homes[0].id);
    }
  }, [homes]);

  const goToLogin = () => {
    setView("login");
    setOtpStep("request");
    setOtpEmail("");
    setEnteredOtp("");
    setNewPassword("");
    setConfirmPassword("");
    setChangeToken(null);
    setForceNewPassword("");
    setForceConfirmPassword("");
    setOtpSuccessMsg(null);
    setError(null);
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          identifier: identifier.trim(),
          password,
          role,
          homeId: selectedHomeId,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Login failed");
      }

      if (data.requiresPasswordChange) {
        setChangeToken(data.changeToken);
        setOtpSuccessMsg(
          data.message || "Please choose a new password to continue.",
        );
        setView("forceChange");
        return;
      }

      onLoginSuccess(data.user);
    } catch (err: any) {
      setError(err.message || "An error occurred during authentication");
    } finally {
      setLoading(false);
    }
  };

  const handleForceChangePassword = async () => {
    if (forceNewPassword.length < 8) {
      setError("New password must be at least 8 characters");
      return;
    }
    if (forceNewPassword !== forceConfirmPassword) {
      setError("Passwords do not match");
      return;
    }
    setError(null);
    setForceLoading(true);
    try {
      const res = await fetch("/api/auth/set-initial-password", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ changeToken, newPassword: forceNewPassword }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to set new password");

      onLoginSuccess(data.user);
    } catch (err: any) {
      setError(err.message || "Failed to set new password");
    } finally {
      setForceLoading(false);
    }
  };

  const handleRequestOtp = async () => {
    if (!otpEmail) {
      setError("Please enter your email to receive a verification code");
      return;
    }
    setError(null);
    setOtpLoading(true);
    try {
      const res = await fetch("/api/auth/request-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: otpEmail.trim() }),
      });
      const data = await res.json();
      if (!res.ok)
        throw new Error(
          data.error?.message ||
            data.error ||
            "Failed to send verification code",
        );

      setOtpSuccessMsg(
        data.message ||
          "If an account exists for that email, a code has been sent to it.",
      );
      setOtpStep("reset");
    } catch (err: any) {
      setError(err.message || "Failed to send verification code");
    } finally {
      setOtpLoading(false);
    }
  };

  const handleVerifyOtp = async () => {
    if (!enteredOtp) {
      setError("Please enter the verification code from your email");
      return;
    }
    if (newPassword.length < 8) {
      setError("New password must be at least 8 characters");
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }
    setError(null);
    setOtpLoading(true);
    try {
      const res = await fetch("/api/auth/verify-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: otpEmail.trim(),
          otpCode: enteredOtp.trim(),
          newPassword,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Verification failed");

      setOtpSuccessMsg(
        "Password reset successfully. You can now log in with your new password.",
      );
      setTimeout(() => {
        setIdentifier(data.email || otpEmail);
        setPassword("");
        goToLogin();
      }, 1500);
    } catch (err: any) {
      setError(err.message || "Verification failed");
    } finally {
      setOtpLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-slate-950/95 flex items-center justify-center p-4 z-50 overflow-y-auto">
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute left-1/2 top-16 h-72 w-72 -translate-x-1/2 rounded-full bg-violet-500/20 blur-3xl" />
        <div className="absolute -left-16 top-32 h-56 w-56 rounded-full bg-cyan-500/10 blur-3xl" />
        <div className="absolute right-0 bottom-10 h-72 w-72 rounded-full bg-indigo-500/10 blur-3xl" />
        <div className="absolute inset-x-0 bottom-0 h-40 bg-gradient-to-t from-slate-950/90 via-slate-950/40 to-transparent" />
      </div>
      <div className="absolute left-1/2 top-1/2 h-44 w-[380px] -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/10 bg-slate-900/70 blur-2xl" />
      <div className="relative w-full max-w-md bg-white rounded-[32px] border border-slate-200 shadow-2xl overflow-hidden">
        <div className="p-6 sm:p-8">
          <div className="flex items-center gap-4 mb-6">
            <div className="flex h-14 w-14 items-center justify-center rounded-3xl bg-indigo-600 text-white text-2xl font-bold">
              F
            </div>
            <div>
              <h2 className="text-2xl font-semibold text-slate-900 tracking-tight">
                FIGA Video Training
              </h2>
              <p className="text-sm text-slate-500">
                Authorized Staff & Admin Portal
              </p>
            </div>
          </div>

          {error && (
            <div className="mb-4 p-3 bg-rose-50 border border-rose-200 rounded-2xl flex items-start gap-2 text-rose-700 text-xs">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {otpSuccessMsg && (
            <div className="mb-4 p-3 bg-emerald-50 border border-emerald-200 rounded-2xl flex items-start gap-2 text-emerald-700 text-xs">
              <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{otpSuccessMsg}</span>
            </div>
          )}

          {view === "login" && (
            <>
              <div className="flex gap-2 mb-6 rounded-3xl bg-slate-100 p-1.5">
                <button
                  type="button"
                  onClick={() => {
                    setRole("staff");
                    setError(null);
                  }}
                  className={`flex-1 rounded-3xl px-4 py-3 text-sm font-semibold transition-all ${
                    role === "staff"
                      ? "bg-white text-slate-900 shadow-sm"
                      : "text-slate-500 hover:text-slate-900"
                  }`}
                >
                  Staff (Trainee)
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setRole("admin");
                    setError(null);
                  }}
                  className={`flex-1 rounded-3xl px-4 py-3 text-sm font-semibold transition-all ${
                    role === "admin"
                      ? "bg-indigo-600 text-white shadow-lg shadow-indigo-200"
                      : "text-slate-500 hover:text-slate-900"
                  }`}
                >
                  Admin
                </button>
              </div>

              <form onSubmit={handleLogin} className="space-y-5">
                <div>
                  <label
                    htmlFor="login-identifier"
                    className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1"
                  >
                    Email or Username
                  </label>
                  <div className="relative">
                    <Mail className="w-4 h-4 text-slate-400 absolute left-4 top-3.5 pointer-events-none" />
                    <input
                      id="login-identifier"
                      type="text"
                      required
                      autoComplete="username"
                      value={identifier}
                      onChange={(e) => setIdentifier(e.target.value)}
                      placeholder="you@example.com or your username"
                      className="w-full pl-11 pr-4 py-3 rounded-2xl bg-slate-50 border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:bg-white transition-all text-slate-900"
                    />
                  </div>
                </div>

                <div>
                  <label
                    htmlFor="login-password"
                    className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1"
                  >
                    Password
                  </label>
                  <div className="relative">
                    <Lock className="w-4 h-4 text-slate-400 absolute left-4 top-3.5 pointer-events-none" />
                    <input
                      id="login-password"
                      type="password"
                      required
                      autoComplete="current-password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="Enter your password"
                      className="w-full pl-11 pr-4 py-3 rounded-2xl bg-slate-50 border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:bg-white transition-all text-slate-900"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1 flex items-center justify-between">
                    <span>Verify Home Location</span>
                    <span className="text-[10px] text-indigo-600 font-semibold">
                      Strict Verification
                    </span>
                  </label>
                  <div className="relative">
                    <select
                      value={selectedHomeId}
                      onChange={(e) =>
                        setSelectedHomeId(parseInt(e.target.value, 10))
                      }
                      className="w-full px-4 py-3 rounded-2xl bg-slate-50 border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:bg-white transition-all text-slate-900 appearance-none font-medium"
                    >
                      {homes.map((h) => (
                        <option key={h.id} value={h.id}>
                          {h.name} ({h.code})
                        </option>
                      ))}
                    </select>
                    <Building2 className="w-4 h-4 text-slate-400 absolute right-4 top-3.5 pointer-events-none" />
                  </div>
                </div>

                <div className="flex items-center justify-between pt-1">
                  <button
                    type="button"
                    onClick={() => {
                      setError(null);
                      setOtpSuccessMsg(null);
                      setView("forgot");
                    }}
                    className="text-xs text-indigo-600 hover:underline font-semibold flex items-center gap-1"
                  >
                    <KeyRound className="w-3.5 h-3.5" />
                    Forgot password?
                  </button>
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full rounded-3xl bg-indigo-600 py-3.5 text-sm font-semibold text-white shadow-xl shadow-indigo-200 transition hover:bg-indigo-700"
                >
                  {loading
                    ? "Verifying..."
                    : `Login as ${role === "admin" ? "Admin" : "Staff"}`}
                </button>
              </form>
            </>
          )}

          {view === "forceChange" && (
            <div className="space-y-4">
              <h3 className="text-sm font-bold text-slate-800">
                Choose Your Own Password
              </h3>
              <p className="text-xs text-slate-500">
                An administrator set a temporary password for your account.
                Choose a new one only you know before continuing.
              </p>

              <div>
                <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1">
                  New Password
                </label>
                <input
                  type="password"
                  value={forceNewPassword}
                  onChange={(e) => setForceNewPassword(e.target.value)}
                  placeholder="At least 8 characters"
                  className="w-full px-4 py-2.5 rounded-2xl bg-slate-50 border border-slate-200 text-sm"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1">
                  Confirm New Password
                </label>
                <input
                  type="password"
                  value={forceConfirmPassword}
                  onChange={(e) => setForceConfirmPassword(e.target.value)}
                  placeholder="Re-enter new password"
                  className="w-full px-4 py-2.5 rounded-2xl bg-slate-50 border border-slate-200 text-sm"
                />
              </div>

              <button
                type="button"
                onClick={handleForceChangePassword}
                disabled={forceLoading}
                className="w-full py-3.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-2xl font-bold text-sm shadow-xl shadow-indigo-200 transition-all"
              >
                {forceLoading ? "Saving..." : "Set Password & Continue"}
              </button>
            </div>
          )}

          {view === "forgot" && (
            <div className="space-y-4">
              <h3 className="text-sm font-bold text-slate-800">
                Reset Your Password
              </h3>

              {otpStep === "request" ? (
                <>
                  <p className="text-xs text-slate-500">
                    Enter your registered email address. We'll email you a
                    verification code.
                  </p>

                  <div>
                    <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1">
                      Email
                    </label>
                    <input
                      type="email"
                      required
                      value={otpEmail}
                      onChange={(e) => setOtpEmail(e.target.value)}
                      placeholder="you@example.com"
                      className="w-full px-4 py-2.5 rounded-2xl bg-slate-50 border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    />
                  </div>

                  <button
                    type="button"
                    onClick={handleRequestOtp}
                    disabled={otpLoading}
                    className="w-full py-3 bg-indigo-600 hover:bg-indigo-700 text-white rounded-2xl text-xs font-bold shadow-md shadow-indigo-200"
                  >
                    {otpLoading ? "Sending..." : "Send Verification Code"}
                  </button>
                </>
              ) : (
                <>
                  <p className="text-xs text-slate-500">
                    Enter the verification code we emailed to{" "}
                    <strong className="text-slate-800">{otpEmail}</strong>, then
                    choose a new password.
                  </p>

                  <div>
                    <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1">
                      Verification Code
                    </label>
                    <input
                      type="text"
                      value={enteredOtp}
                      onChange={(e) => setEnteredOtp(e.target.value)}
                      placeholder="6-digit code"
                      className="w-full px-4 py-2.5 rounded-2xl bg-slate-50 border border-slate-200 text-sm font-mono tracking-widest text-center"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1">
                      New Password
                    </label>
                    <input
                      type="password"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      placeholder="At least 8 characters"
                      className="w-full px-4 py-2.5 rounded-2xl bg-slate-50 border border-slate-200 text-sm"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1">
                      Confirm New Password
                    </label>
                    <input
                      type="password"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      placeholder="Re-enter new password"
                      className="w-full px-4 py-2.5 rounded-2xl bg-slate-50 border border-slate-200 text-sm"
                    />
                  </div>

                  <button
                    type="button"
                    onClick={handleVerifyOtp}
                    disabled={otpLoading}
                    className="w-full py-3 bg-emerald-600 hover:bg-emerald-700 text-white rounded-2xl font-bold text-xs shadow-lg shadow-emerald-200"
                  >
                    {otpLoading ? "Resetting..." : "Reset Password"}
                  </button>
                </>
              )}

              <button
                type="button"
                onClick={goToLogin}
                className="w-full py-2 text-xs text-slate-500 hover:text-slate-800 font-semibold"
              >
                Back to Login
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
