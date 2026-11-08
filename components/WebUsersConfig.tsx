"use client";

import { useCallback, useEffect, useState } from "react";
import { copyText } from "@/lib/clipboard";
import { useI18n } from "@/hooks/useI18n";
import styles from "./SettingsConfig.module.css";

type WebRole = "admin" | "user";

type ListedUser = {
  username: string;
  role: WebRole;
  projects: string[] | "*";
  machines: string[] | "*";
  tokens: { name: string; created: string }[];
  envBacked?: boolean;
};

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: init?.body ? { "Content-Type": "application/json", ...(init?.headers ?? {}) } : init?.headers,
  });
  const result = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok || result.error) throw new Error(result.error ?? `HTTP ${response.status}`);
  return result;
}


// One absolute path per line, or a single "*" line for full visibility.
function parseProjectsText(text: string): string[] | "*" | null {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length === 1 && lines[0] === "*") return "*";
  if (lines.some((line) => line === "*" || !line.startsWith("/"))) return null;
  return lines;
}

// Local-only: /api/web-users is gateway-local administration, never proxied.
function userUrl(username: string, suffix = ""): string {
  return `/api/web-users/${encodeURIComponent(username)}${suffix}`;
}

export function WebUsersConfig() {
  const { t } = useI18n();
  const [users, setUsers] = useState<ListedUser[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Editor form state (create + edit share the role/projects/machines fields).
  const [newUsername, setNewUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<WebRole>("user");
  const [projectsText, setProjectsText] = useState("");
  const [machines, setMachines] = useState<string[] | "*">([]);
  const [registry, setRegistry] = useState<{ id: string; name: string }[]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Token state.
  const [tokenName, setTokenName] = useState("");
  const [rawToken, setRawToken] = useState<{ name: string; raw: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await request<{ users: ListedUser[] }>("/api/web-users", { cache: "no-store" });
      setUsers(result.users);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // The registry admins can grant from — an admin always sees the full
  // fleet here (this component is admin-only, `requiresAdmin: true`).
  useEffect(() => {
    request<{ machines: { id: string; name: string }[] }>("/api/machines", { cache: "no-store" })
      .then((result) => setRegistry(result.machines.filter((machine) => machine.id !== "local")))
      .catch(() => setRegistry([]));
  }, []);

  const currentUser = users?.find((user) => user.username === selected) ?? null;

  // Resync the editor form whenever the selection (or the reloaded user record) changes.
  useEffect(() => {
    setConfirmDelete(false);
    setRawToken(null);
    setCopied(false);
    setTokenName("");
    setPassword("");
    setRole(currentUser?.role ?? "user");
    setProjectsText(currentUser ? (currentUser.projects === "*" ? "*" : currentUser.projects.join("\n")) : "");
    setMachines(currentUser?.machines ?? []);
  }, [currentUser]);

  const startCreate = () => {
    setSelected(null);
    setCreating(true);
    setConfirmDelete(false);
    setRawToken(null);
    setTokenName("");
    setNewUsername("");
    setPassword("");
    setRole("user");
    setProjectsText("");
    setMachines([]);
    setError(null);
  };

  const createUser = async () => {
    const username = newUsername.trim().toLowerCase();
    if (!username || !password || busy) return;
    const projects = parseProjectsText(projectsText);
    if (!projects) {
      setError(t("webUsers.invalidProjects"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await request("/api/web-users", { method: "POST", body: JSON.stringify({ username, password, role, projects, machines }) });
      setCreating(false);
      setSelected(username);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const saveUser = async () => {
    if (!currentUser || busy) return;
    const projects = parseProjectsText(projectsText);
    if (!projects) {
      setError(t("webUsers.invalidProjects"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await request(userUrl(currentUser.username), {
        method: "PATCH",
        body: JSON.stringify({ role, projects, machines, ...(password ? { password } : {}) }),
      });
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const deleteUser = async () => {
    if (!currentUser || busy) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await request(userUrl(currentUser.username), { method: "DELETE" });
      setSelected(null);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
      setConfirmDelete(false);
    }
  };

  const createToken = async () => {
    if (!currentUser || busy) return;
    const name = tokenName.trim();
    if (!name) return;
    setBusy(true);
    setError(null);
    try {
      const result = await request<{ name: string; raw: string; created: string }>(
        userUrl(currentUser.username, "/tokens"),
        { method: "POST", body: JSON.stringify({ name }) },
      );
      setRawToken({ name: result.name, raw: result.raw });
      setCopied(false);
      setTokenName("");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const revokeToken = async (name: string) => {
    if (!currentUser || busy) return;
    setBusy(true);
    setError(null);
    try {
      await request(userUrl(currentUser.username, `/tokens/${encodeURIComponent(name)}`), { method: "DELETE" });
      if (rawToken?.name === name) setRawToken(null);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const copyRaw = async () => {
    if (!rawToken) return;
    try {
      await copyText(rawToken.raw);
      setCopied(true);
    } catch {
      setError(t("webUsers.copyFailed"));
    }
  };

  const roleSelect = () => (
    <select className={styles.select} value={role} onChange={(event) => setRole(event.target.value as WebRole)}>
      <option value="user">{t("webUsers.roleUser")}</option>
      <option value="admin">{t("webUsers.roleAdmin")}</option>
    </select>
  );

  const projectsField = () => (
    <textarea
      className={styles.jsonEditor}
      style={{ minHeight: 120 }}
      value={projectsText}
      spellCheck={false}
      placeholder={"*\n/home/me/project-a\n/home/me/project-b"}
      onChange={(event) => setProjectsText(event.target.value)}
    />
  );

  const machinesField = () => {
    if (role === "admin") {
      return (
        <div className={styles.readOnlyNotice}>
          {t("webUsers.adminMachines")}
        </div>
      );
    }
    return (
      <>
        <label className={styles.serverRow} style={{ cursor: "pointer", padding: "4px 0" }}>
          <input
            type="checkbox"
            checked={machines === "*"}
            onChange={(event) => setMachines(event.target.checked ? "*" : [])}
          />
          <span className={styles.serverName}>{t("webUsers.allMachines")}</span>
        </label>
        {machines !== "*" && (
          registry.length ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 4 }}>
              {registry.map((machine) => (
                <label key={machine.id} style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={machines.includes(machine.id)}
                    onChange={(event) => setMachines((current) => current === "*"
                      ? current
                      : event.target.checked
                        ? [...current, machine.id]
                        : current.filter((id) => id !== machine.id))}
                  />
                  <span>{machine.name}</span>
                </label>
              ))}
            </div>
          ) : <div className={styles.saveState} style={{ marginTop: 4 }}>{t("webUsers.noMachines")}</div>
        )}
        <div className={styles.saveState} style={{ marginTop: 6 }}>
          {t("webUsers.machineGrantHelp")}
        </div>
      </>
    );
  };

  return (
    <div className={styles.scrollContent}>
      <header className={styles.contentHeader}>
        <h2 className={styles.contentTitle}>{t("webUsers.title")}</h2>
        <p className={styles.contentDescription}>
          {t("webUsers.description")}
        </p>
      </header>
      <div className={styles.settingsBody}>
        {!users ? (
          <div className={styles.empty}>{error ?? t("webUsers.loading")}</div>
        ) : (
          <div className={styles.mcpLayout}>
            <aside className={styles.mcpList}>
              <div className={styles.serverRows}>
                {users.length ? users.map((user) => (
                  <div
                    key={user.username}
                    className={styles.serverRow}
                    data-active={!creating && selected === user.username}
                  >
                    <button
                      type="button"
                      className={styles.serverSelect}
                      title={t("webUsers.userSummary", { role: t(`webUsers.role.${user.role}`), projects: user.projects === "*" ? t("webUsers.allProjects") : user.projects.length === 0 ? t("webUsers.noProjects") : user.projects.length === 1 ? user.projects[0] : t("webUsers.projectCount", { count: user.projects.length }) })}
                      onClick={() => {
                        setCreating(false);
                        setSelected(user.username);
                        setError(null);
                      }}
                    >
                      <span className={styles.statusDot} data-off={user.role !== "admin"} />
                      <span className={styles.serverName}>{user.username}</span>
                      {user.tokens.length > 0 && <span className={styles.sourceBadge}>{t(user.tokens.length === 1 ? "webUsers.tokenCountOne" : "webUsers.tokenCount", { count: user.tokens.length })}</span>}
                      {user.envBacked && <span className={styles.sourceBadge}>{t("webUsers.envReadOnly")}</span>}
                    </button>
                  </div>
                )) : <div className={styles.serverListEmpty}>{t("webUsers.noUsers")}</div>}
              </div>
              <button type="button" className={styles.addServer} onClick={startCreate}>{t("webUsers.addUser")}</button>
            </aside>
            <section className={styles.mcpEditor}>
              {creating ? (
                <>
                  <div className={styles.editorHeader}>
                    <input
                      className={styles.textInput}
                      placeholder={t("webUsers.usernamePlaceholder")}
                      value={newUsername}
                      spellCheck={false}
                      onChange={(event) => setNewUsername(event.target.value)}
                    />
                  </div>
                  <div className={styles.settingLabel} style={{ marginTop: 10 }}>{t("webUsers.password")}</div>
                  <input
                    type="password"
                    className={styles.textInput}
                    value={password}
                    autoComplete="new-password"
                    onChange={(event) => setPassword(event.target.value)}
                  />
                  <div className={styles.settingLabel} style={{ marginTop: 10 }}>{t("webUsers.role")}</div>
                  {roleSelect()}
                  <div className={styles.settingLabel} style={{ marginTop: 10 }}>{t("webUsers.projects")}</div>
                  {projectsField()}
                  <div className={styles.settingLabel} style={{ marginTop: 10 }}>{t("webUsers.machines")}</div>
                  {machinesField()}
                  <div className={styles.editorActions}>
                    <div>{error && <div className={styles.error}>{error}</div>}</div>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button type="button" className={styles.dangerButton} disabled={busy} onClick={() => setCreating(false)}>{t("webUsers.cancel")}</button>
                      <button type="button" className={styles.primaryButton} disabled={busy || !newUsername.trim() || !password} onClick={() => void createUser()}>
                        {t(busy ? "webUsers.creating" : "webUsers.createUser")}
                      </button>
                    </div>
                  </div>
                </>
              ) : currentUser ? (
                <>
                  <div className={styles.editorHeader}>
                    <input className={styles.textInput} value={currentUser.username} readOnly />
                    {!currentUser.envBacked && (
                      <button type="button" className={styles.dangerButton} disabled={busy} onClick={() => void deleteUser()}>
                        {t(confirmDelete ? "webUsers.confirmDelete" : "webUsers.delete")}
                      </button>
                    )}
                  </div>
                  {currentUser.envBacked ? (
                    <div className={styles.readOnlyNotice}>
                      {t("webUsers.envHelp")}
                    </div>
                  ) : (
                    <>
                      <div className={styles.settingLabel}>{t("webUsers.role")}</div>
                      {roleSelect()}
                      <div className={styles.settingLabel} style={{ marginTop: 10 }}>{t("webUsers.projectsHelp")}</div>
                      {projectsField()}
                      <div className={styles.settingLabel} style={{ marginTop: 10 }}>{t("webUsers.machines")}</div>
                      {machinesField()}
                      <div className={styles.settingLabel} style={{ marginTop: 10 }}>{t("webUsers.resetPassword")}</div>
                      <input
                        type="password"
                        className={styles.textInput}
                        placeholder={t("webUsers.passwordPlaceholder")}
                        value={password}
                        autoComplete="new-password"
                        onChange={(event) => setPassword(event.target.value)}
                      />
                      <div className={styles.editorActions}>
                        <div>{error && <div className={styles.error}>{error}</div>}</div>
                        <button type="button" className={styles.primaryButton} disabled={busy} onClick={() => void saveUser()}>
                          {t(busy ? "webUsers.saving" : "webUsers.saveUser")}
                        </button>
                      </div>
                    </>
                  )}
                  {!currentUser.envBacked && (
                    <div style={{ marginTop: 22 }}>
                      <div className={styles.settingLabel}>{t("webUsers.apiTokens")}</div>
                      <div className={styles.saveState}>{t("webUsers.tokensHelp")}</div>
                      {currentUser.tokens.length ? currentUser.tokens.map((token) => (
                        <div key={token.name} className={styles.serverRow} style={{ justifyContent: "space-between", marginTop: 4 }}>
                          <span className={styles.serverName} title={t("webUsers.tokenCreatedAt", { created: token.created })}>{token.name}</span>
                          <button type="button" className={styles.dangerButton} style={{ height: 25 }} disabled={busy} onClick={() => void revokeToken(token.name)}>{t("webUsers.revoke")}</button>
                        </div>
                      )) : <div className={styles.saveState} style={{ marginTop: 4 }}>{t("webUsers.noTokens")}</div>}
                      <div className={styles.editorHeader} style={{ marginTop: 10 }}>
                        <input
                          className={styles.textInput}
                          placeholder={t("webUsers.tokenName")}
                          value={tokenName}
                          spellCheck={false}
                          onChange={(event) => setTokenName(event.target.value)}
                        />
                        <button type="button" className={styles.primaryButton} disabled={busy || !tokenName.trim()} onClick={() => void createToken()}>
                          {t("webUsers.createToken")}
                        </button>
                      </div>
                      {rawToken && (
                        <div style={{ marginTop: 10, padding: 12, border: "1px solid var(--border)", borderRadius: 8 }}>
                          <div className={styles.error}>{t("webUsers.tokenCreated", { name: rawToken.name })}</div>
                          <div className={styles.editorHeader} style={{ marginTop: 8 }}>
                            <input className={styles.textInput} value={rawToken.raw} readOnly onFocus={(event) => event.currentTarget.select()} />
                            <button type="button" className={styles.primaryButton} onClick={() => void copyRaw()}>{t(copied ? "webUsers.copied" : "webUsers.copy")}</button>
                            <button type="button" className={styles.dangerButton} onClick={() => setRawToken(null)}>{t("webUsers.dismiss")}</button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                  {currentUser.envBacked && error && <div className={styles.error} style={{ marginTop: 10 }}>{error}</div>}
                </>
              ) : (
                <div className={styles.empty}>{t("webUsers.selectUser")}</div>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
