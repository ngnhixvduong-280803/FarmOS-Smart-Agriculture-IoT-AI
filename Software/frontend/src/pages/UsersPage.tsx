import React, { useState, useEffect, useMemo } from "react";
import {
  Plus,
  Search,
  User,
  Shield,
  Trash2,
  RefreshCw,
  X,
  Check,
  Cpu,
  Radio,
  ChevronDown,
  ChevronRight,
  Eye,
  MapPin,
  Copy,
} from "lucide-react";
import { useI18n } from "../context/I18nContext";
import {
  fetchUsers,
  createAdminUser,
  updateUserRole,
  deleteUser,
  deleteNode,
  getCurrentUser,
} from "../services/api.service";
import { UserProfile, NodeDevice } from "../types";
import { DeviceDetailModal } from "../components/DeviceDetailModal";
import { EditNodeLocationModal } from "../components/EditNodeLocationModal";
import { AddNodeModal } from "../components/AddNodeModal";

export interface UsersPageProps {
  isActive?: boolean;
}

export const UsersPage: React.FC<UsersPageProps> = ({ isActive = true }) => {
  const { t } = useI18n();
  const currentUser = getCurrentUser();

  const [users, setUsers] = useState<UserProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedUsers, setExpandedUsers] = useState<Record<string, boolean>>({});
  const [copiedField, setCopiedField] = useState<string | null>(null);

  // Modals state
  const [isAddUserModalOpen, setIsAddUserModalOpen] = useState(false);
  const [isAddNodeModalOpen, setIsAddNodeModalOpen] = useState(false);
  const [isDetailModalOpen, setIsDetailModalOpen] = useState(false);
  const [isEditLocationOpen, setIsEditLocationOpen] = useState(false);
  const [selectedNode, setSelectedNode] = useState<NodeDevice | null>(null);

  // New user form state
  const [newEmail, setNewEmail] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newName, setNewName] = useState("");
  const [newRole, setNewRole] = useState<"USER" | "ADMIN">("USER");
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleCopy = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedField(id);
    setTimeout(() => setCopiedField(null), 1800);
  };

  const toggleUserExpand = (userId: string) => {
    setExpandedUsers((prev) => ({
      ...prev,
      [userId]: !prev[userId],
    }));
  };

  const loadUsers = async (silent = false) => {
    try {
      if (!silent) setLoading(true);
      const data = await fetchUsers();
      setUsers(data);
    } catch (err: any) {
      console.error("Lỗi tải danh sách khách hàng:", err);
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => {
    loadUsers();
  }, []);

  useEffect(() => {
    if (isActive) {
      void loadUsers(true);
    }
  }, [isActive]);

  const handleRoleToggle = async (user: UserProfile) => {
    const nextRole = user.role === "ADMIN" ? "USER" : "ADMIN";
    if (
      window.confirm(
        t.usersPage.confirmRoleChange
          .replace("{{email}}", user.email)
          .replace("{{role}}", nextRole),
      )
    ) {
      try {
        await updateUserRole(user.id, nextRole);
        setUsers((prev) =>
          prev.map((u) => (u.id === user.id ? { ...u, role: nextRole as any } : u))
        );
      } catch (err: any) {
        alert(t.usersPage.roleChangeError + err.message);
      }
    }
  };

  const handleDeleteUser = async (user: UserProfile) => {
    if (
      window.confirm(
        t.usersPage.confirmDeleteUser.replace("{{email}}", user.email),
      )
    ) {
      try {
        await deleteUser(user.id);
        setUsers((prev) => prev.filter((u) => u.id !== user.id));
      } catch (err: any) {
        alert(t.usersPage.deleteUserError + err.message);
      }
    }
  };

  const handleDeleteNode = async (nodeId: string, nodeName?: string | null) => {
    const displayName = nodeName || nodeId;
    if (
      window.confirm(
        t.usersPage.deleteNodeConfirm.replace("{{name}}", displayName),
      )
    ) {
      try {
        await deleteNode(nodeId);
        void loadUsers(true);
        window.dispatchEvent(new CustomEvent("farmos:node-updated"));
      } catch (err: any) {
        alert(t.usersPage.deleteNodeError + err.message);
      }
    }
  };

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newEmail || !newPassword) {
      setFormError(t.usersPage.formValidation);
      return;
    }

    try {
      setSubmitting(true);
      setFormError(null);
      const created = await createAdminUser({
        email: newEmail.trim(),
        password: newPassword,
        name: newName.trim() || undefined,
        role: newRole,
      });

      setUsers((prev) => [created, ...prev]);
      setIsAddUserModalOpen(false);
      setNewEmail("");
      setNewPassword("");
      setNewName("");
    } catch (err: any) {
      setFormError(err.message || t.usersPage.createError);
    } finally {
      setSubmitting(false);
    }
  };

  // KPI calculations across all customers
  const stats = useMemo(() => {
    let totalGateways = 0;
    let totalSensorNodes = 0;
    let totalStandaloneNodes = 0;
    let totalOnline = 0;
    let totalNodes = 0;

    users.forEach((u) => {
      totalGateways += u.gatewaysCount || 0;
      totalSensorNodes += u.sensorNodesCount || 0;
      totalStandaloneNodes += u.standaloneNodes?.length || 0;
      totalOnline += u.totalOnline || 0;
      totalNodes += u.nodesCount || 0;
    });

    const totalChildNodes = Math.max(0, totalSensorNodes - totalStandaloneNodes);
    const onlineRate = totalNodes > 0 ? Math.round((totalOnline / totalNodes) * 100) : 100;

    return {
      totalCustomers: users.length,
      totalGateways,
      totalSensorNodes,
      totalStandaloneNodes,
      totalChildNodes,
      totalOnline,
      totalNodes,
      onlineRate,
    };
  }, [users]);

  // Filter users by search
  const filteredUsers = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    if (!q) return users;

    return users.filter((u) => {
      const matchNameOrEmail =
        u.email.toLowerCase().includes(q) || (u.name || "").toLowerCase().includes(q);
      const matchFarm = u.farms?.some((f) => f.name.toLowerCase().includes(q));
      const matchNode = u.nodes?.some(
        (n) =>
          n.id.toLowerCase().includes(q) ||
          (n.name || "").toLowerCase().includes(q) ||
          (n.serial_number || "").toLowerCase().includes(q)
      );

      return matchNameOrEmail || matchFarm || matchNode;
    });
  }, [users, searchQuery]);

  if (currentUser && currentUser.role !== "ADMIN") {
    return (
      <div className="admin-alert admin-alert--error p-8 text-center max-w-lg mx-auto mt-12">
        <Shield className="w-10 h-10 text-rose-500 mx-auto mb-2" />
        <h2 className="text-base font-bold text-rose-800 dark:text-rose-300">
          {t.usersPage.forbiddenTitle}
        </h2>
        <p className="text-xs text-slate-500 mt-1">
          {t.usersPage.forbiddenDesc}
        </p>
      </div>
    );
  }

  return (
    <div className="admin-page space-y-6 pb-12">
      {/* Header */}
      <header className="admin-page__header">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <p className="eyebrow">{t.usersPage.systemAdmin}</p>
            <span className="status-chip status-chip--neutral">{t.usersPage.adminPortal}</span>
          </div>
          <h1 className="admin-page__title">{t.usersPage.pageTitle}</h1>
          <p className="admin-page__intro">
            {t.usersPage.pageIntro}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => loadUsers(false)}
            className="action action-light"
            disabled={loading}
            title={t.usersPage.reloadTooltip}
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            {t.usersPage.refresh}
          </button>

          <button
            type="button"
            onClick={() => setIsAddNodeModalOpen(true)}
            className="action action-light"
          >
            <Plus className="h-3.5 w-3.5 text-emerald-700 dark:text-emerald-400" />
            {t.usersPage.assignDevice}
          </button>

          <button
            type="button"
            onClick={() => setIsAddUserModalOpen(true)}
            className="action action-dark"
          >
            <User className="h-3.5 w-3.5" />
            {t.usersPage.createAccount}
          </button>
        </div>
      </header>

      {/* KPI Summary Strip */}
      <section className="inventory-summary grid-cols-2 lg:grid-cols-4" aria-label={t.usersPage.kpiAria}>
        <div className="inventory-summary__item">
          <span>{t.usersPage.kpiCustomers}</span>
          <strong>{stats.totalCustomers}</strong>
          <small>{t.usersPage.kpiCustomersDesc}</small>
        </div>

        <div className="inventory-summary__item">
          <span>{t.usersPage.kpiGateways}</span>
          <strong>{stats.totalGateways}</strong>
          <small>{t.usersPage.kpiGatewaysDesc}</small>
        </div>

        <div className="inventory-summary__item">
          <span>{t.usersPage.kpiSensors}</span>
          <strong>{stats.totalSensorNodes}</strong>
          <small>
            {t.usersPage.kpiSensorsDesc
              .replace("{{child}}", String(stats.totalChildNodes))
              .replace("{{standalone}}", String(stats.totalStandaloneNodes))}
          </small>
        </div>

        <div className="inventory-summary__item">
          <span>{t.usersPage.kpiOnline}</span>
          <strong>
            {stats.totalOnline}
            <span className="text-sm font-normal text-slate-400"> / {stats.totalNodes}</span>
          </strong>
          <small>
            {t.usersPage.kpiOnlineRate.replace("{{rate}}", String(stats.onlineRate))}
          </small>
        </div>
      </section>

      {/* Main Admin Panel & Table */}
      <section className="admin-panel overflow-hidden rounded-xl">
        {/* Toolbar */}
        <div className="admin-panel__toolbar">
          <label className="relative min-w-0 flex-1 sm:max-w-md">
            <span className="sr-only">{t.usersPage.searchAria}</span>
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              placeholder={t.usersPage.searchPlaceholderDetailed}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="field pl-9"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery("")}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 p-0.5 rounded"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </label>

          <div className="text-xs text-slate-500 shrink-0">
            {t.usersPage.showingCount
              .replace("{{shown}}", String(filteredUsers.length))
              .replace("{{total}}", String(users.length))}
          </div>
        </div>

        {/* Customer Table */}
        <div className="overflow-x-auto">
          <table className="data-table min-w-[780px]">
            <thead>
              <tr>
                <th className="w-10 text-center"><span className="sr-only">{t.usersPage.expandAria}</span></th>
                <th>{t.usersPage.colCustomer}</th>
                <th>{t.usersPage.colRole}</th>
                <th>{t.usersPage.colInfrastructure}</th>
                <th>{t.usersPage.colConnectionStatus}</th>
                <th>{t.usersPage.colJoinDate}</th>
                <th className="text-right">{t.usersPage.colActions}</th>
              </tr>
            </thead>
            <tbody>
              {loading && users.length === 0 ? (
                <tr>
                  <td colSpan={7} className="data-table__empty">
                    <RefreshCw className="w-5 h-5 animate-spin mx-auto mb-2 text-emerald-600" />
                    {t.usersPage.loadingData}
                  </td>
                </tr>
              ) : filteredUsers.length === 0 ? (
                <tr>
                  <td colSpan={7} className="data-table__empty">
                    {t.usersPage.noMatchingUsers}
                  </td>
                </tr>
              ) : (
                filteredUsers.map((u) => {
                  const isExpanded = expandedUsers[u.id] ?? false;
                  const totalDevs = u.nodesCount || 0;
                  const onlineDevs = u.totalOnline || 0;
                  const allOnline = totalDevs > 0 && onlineDevs === totalDevs;

                  return (
                    <React.Fragment key={u.id}>
                      {/* Master Customer Row */}
                      <tr
                        onClick={() => toggleUserExpand(u.id)}
                        className={`cursor-pointer ${isExpanded ? "is-selected" : ""}`}
                      >
                        {/* Expand Chevron */}
                        <td
                          className="text-center"
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleUserExpand(u.id);
                          }}
                        >
                          <button
                            type="button"
                            className="icon-action text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                            aria-expanded={isExpanded}
                            aria-label={t.usersPage.expandUserAria.replace("{{name}}", u.name || u.email)}
                          >
                            {isExpanded ? (
                              <ChevronDown className="w-4 h-4 text-emerald-700 dark:text-emerald-400" />
                            ) : (
                              <ChevronRight className="w-4 h-4" />
                            )}
                          </button>
                        </td>

                        {/* Customer Identity */}
                        <td>
                          <div className="flex items-center gap-2.5">
                            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-900 text-xs font-semibold text-white dark:bg-emerald-700">
                              {(u.name || u.email).charAt(0).toUpperCase()}
                            </div>
                            <div className="min-w-0">
                              <div className="font-semibold text-slate-900 dark:text-slate-100 truncate">
                                {u.name || t.usersPage.customerDefault}
                              </div>
                              <div className="text-[11px] text-slate-500 font-mono truncate">
                                {u.email}
                              </div>
                            </div>
                          </div>
                        </td>

                        {/* Role */}
                        <td onClick={(e) => e.stopPropagation()}>
                          <button
                            type="button"
                            onClick={() => handleRoleToggle(u)}
                            className={`status-chip transition hover:opacity-80 ${
                              u.role === "ADMIN"
                                ? "status-chip--warning font-semibold"
                                : "status-chip--neutral"
                            }`}
                            title={t.usersPage.roleToggleTooltip}
                          >
                            <Shield className="w-3 h-3" />
                            <span>{u.role}</span>
                          </button>
                        </td>

                        {/* Farm & Device Infrastructure counts */}
                        <td>
                          <div className="text-xs text-slate-600 dark:text-slate-300">
                            <span className="font-medium text-slate-900 dark:text-slate-100">
                              {u.farmsCount || (u.farms ? u.farms.length : 0)}
                            </span>{" "}
                            {t.usersPage.farmsCountUnit}
                            <span className="mx-1.5 text-slate-300 dark:text-slate-600">·</span>
                            <span className="font-medium text-slate-900 dark:text-slate-100">
                              {u.gatewaysCount || 0}
                            </span>{" "}
                            {t.usersPage.gatewaysCountUnit}
                            <span className="mx-1.5 text-slate-300 dark:text-slate-600">·</span>
                            <span className="font-medium text-slate-900 dark:text-slate-100">
                              {u.sensorNodesCount || 0}
                            </span>{" "}
                            {t.usersPage.nodesCountUnit}
                          </div>
                          {u.farms && u.farms.length > 0 && (
                            <div className="text-[11px] text-slate-400 truncate max-w-[220px] mt-0.5">
                              {u.farms.map((f) => f.name).join(", ")}
                            </div>
                          )}
                        </td>

                        {/* Connection status */}
                        <td>
                          {totalDevs === 0 ? (
                            <span className="status-chip status-chip--neutral">
                              {t.usersPage.noDevices}
                            </span>
                          ) : allOnline ? (
                            <span className="status-chip status-chip--success">
                              {t.usersPage.onlineRatio
                                .replace("{{online}}", String(onlineDevs))
                                .replace("{{total}}", String(totalDevs))}
                            </span>
                          ) : (
                            <span className="status-chip status-chip--warning">
                              {t.usersPage.onlineRatio
                                .replace("{{online}}", String(onlineDevs))
                                .replace("{{total}}", String(totalDevs))}
                            </span>
                          )}
                        </td>

                        {/* Created Date */}
                        <td className="text-xs text-slate-500">
                          {u.created_at
                            ? new Date(u.created_at).toLocaleDateString("vi-VN")
                            : t.usersPage.today}
                        </td>

                        {/* Row Actions */}
                        <td className="text-right" onClick={(e) => e.stopPropagation()}>
                          <div className="flex items-center justify-end gap-1">
                            <button
                              type="button"
                              onClick={() => toggleUserExpand(u.id)}
                              className="action action-light py-1 px-2.5 text-[11px]"
                            >
                              {isExpanded ? t.usersPage.collapseDevices : t.usersPage.viewDevices}
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDeleteUser(u)}
                              className="icon-action text-slate-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/30"
                              title={t.usersPage.deleteCustomerAria}
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </td>
                      </tr>

                      {/* Expanded Sub-Panel: Customer Device Network Topology */}
                      {isExpanded && (
                        <tr className="data-table__detail">
                          <td colSpan={7} className="p-0!">
                            <div className="bg-slate-50/60 dark:bg-slate-950/40 p-4 sm:p-5 border-t border-b border-slate-200/80 dark:border-slate-800 space-y-5">
                              {/* Sub-Panel Header */}
                              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-slate-200 dark:border-slate-800">
                                <div>
                                  <div className="flex items-center gap-2">
                                    <p className="eyebrow">{t.usersPage.deviceInfraTitle}</p>
                                    <span className="text-xs text-slate-400">·</span>
                                    <span className="text-xs font-semibold text-slate-800 dark:text-slate-200">
                                      {u.name || u.email}
                                    </span>
                                  </div>
                                  <p className="text-xs text-slate-500 mt-0.5">
                                    {t.usersPage.deviceInfraTotal
                                      .replace("{{gateways}}", String(u.gatewaysCount || 0))
                                      .replace("{{sensors}}", String(u.sensorNodesCount || 0))
                                      .replace("{{online}}", String(onlineDevs))
                                      .replace("{{total}}", String(totalDevs))}
                                  </p>
                                </div>

                                <button
                                  type="button"
                                  onClick={() => setIsAddNodeModalOpen(true)}
                                  className="action action-light self-start sm:self-auto text-xs"
                                >
                                  <Plus className="w-3.5 h-3.5 text-emerald-700 dark:text-emerald-400" />
                                  <span>{t.usersPage.assignMoreForClient}</span>
                                </button>
                              </div>

                              {/* No devices state */}
                              {totalDevs === 0 && (
                                <div className="p-8 text-center bg-white dark:bg-slate-900 border border-dashed border-slate-200 dark:border-slate-800 rounded-lg">
                                  <p className="text-xs text-slate-600 dark:text-slate-300 font-medium">
                                    {t.usersPage.clientNoDevicesTitle}
                                  </p>
                                  <p className="text-[11px] text-slate-400 mt-1 max-w-sm mx-auto">
                                    {t.usersPage.clientNoDevicesHint}
                                  </p>
                                  <button
                                    type="button"
                                    onClick={() => setIsAddNodeModalOpen(true)}
                                    className="mt-3 action action-dark text-xs"
                                  >
                                    <Plus className="w-3.5 h-3.5" />
                                    <span>{t.usersPage.assignDeviceNow}</span>
                                  </button>
                                </div>
                              )}

                              {/* 1. MẠNG TRẠM GATEWAY & CÁC NODE CON */}
                              {u.gateways && u.gateways.length > 0 && (
                                <div className="space-y-3">
                                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1">
                                    <div className="flex items-center gap-2">
                                      <Radio className="w-3.5 h-3.5 text-slate-500" />
                                      <span className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                                        {t.usersPage.gatewayNetworkTitle.replace("{{count}}", String(u.gateways.length))}
                                      </span>
                                    </div>
                                    <span className="text-[11px] text-slate-400">
                                      {t.usersPage.gatewayNetworkHint}
                                    </span>
                                  </div>

                                  <div className="space-y-3">
                                    {u.gateways.map((gw) => (
                                      <div
                                        key={gw.id}
                                        className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden shadow-2xs"
                                      >
                                        {/* Gateway Station Bar */}
                                        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 p-3 bg-slate-50/70 dark:bg-slate-950/40 border-b border-slate-200/80 dark:border-slate-800 text-xs">
                                          <div className="flex items-center gap-2.5 min-w-0">
                                            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-slate-200/80 text-slate-700 dark:bg-slate-800 dark:text-slate-200">
                                              <Radio className="w-3.5 h-3.5" />
                                            </div>
                                            <div className="min-w-0">
                                              <div className="flex flex-wrap items-center gap-2">
                                                <span className="font-semibold text-slate-900 dark:text-white truncate">
                                                  {gw.name || gw.id}
                                                </span>
                                                <span className="status-chip status-chip--neutral font-mono text-[10px]">
                                                  GATEWAY
                                                </span>
                                                <span className="text-[11px] text-slate-500">
                                                  {t.usersPage.connectedNodesCount.replace("{{count}}", String(gw.totalChildCount))}
                                                </span>
                                              </div>
                                              <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-500 font-mono mt-0.5">
                                                <button
                                                  type="button"
                                                  onClick={() => handleCopy(gw.id, `gw-${gw.id}`)}
                                                  className="hover:text-slate-800 dark:hover:text-slate-200 flex items-center gap-1"
                                                  title={t.usersPage.copyGatewayId}
                                                >
                                                  <span>ID: {gw.id}</span>
                                                  {copiedField === `gw-${gw.id}` ? (
                                                    <Check className="w-2.5 h-2.5 text-emerald-600" />
                                                  ) : (
                                                    <Copy className="w-2.5 h-2.5 text-slate-400" />
                                                  )}
                                                </button>
                                                {gw.serial_number && <span>· SN: {gw.serial_number}</span>}
                                                {gw.farm && (
                                                  <span className="font-sans text-slate-600 dark:text-slate-400">
                                                    · {t.nodesPage.farmPrefix}{gw.farm.name}
                                                  </span>
                                                )}
                                              </div>
                                            </div>
                                          </div>

                                          {/* Gateway Metrics & Actions */}
                                          <div className="flex flex-wrap items-center gap-2.5 shrink-0 ml-auto md:ml-0">
                                            {/* Status Badge */}
                                            <span
                                              className={`status-chip ${
                                                gw.online
                                                  ? "status-chip--success"
                                                  : "status-chip--neutral"
                                              }`}
                                            >
                                              {gw.online ? "Online" : "Offline"}
                                            </span>

                                            {/* Location / GPS */}
                                            {gw.latitude && gw.longitude ? (
                                              <button
                                                type="button"
                                                onClick={() => {
                                                  setSelectedNode(gw);
                                                  setIsEditLocationOpen(true);
                                                }}
                                                className="text-[11px] font-mono text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800 transition"
                                                title={t.usersPage.editGpsTooltip}
                                              >
                                                <MapPin className="w-3 h-3 text-slate-400" />
                                                <span>
                                                  {gw.latitude.toFixed(3)}, {gw.longitude.toFixed(3)}
                                                </span>
                                              </button>
                                            ) : (
                                              <button
                                                type="button"
                                                onClick={() => {
                                                  setSelectedNode(gw);
                                                  setIsEditLocationOpen(true);
                                                }}
                                                className="text-[11px] text-slate-400 hover:text-slate-600 flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800 transition"
                                                title={t.usersPage.noGpsTooltip}
                                              >
                                                <MapPin className="w-3 h-3" />
                                                <span>{t.usersPage.noGps}</span>
                                              </button>
                                            )}

                                            {/* Quick Actions */}
                                            <div className="flex items-center gap-1 border-l border-slate-200 dark:border-slate-800 pl-2">
                                              <button
                                                type="button"
                                                onClick={() => {
                                                  setSelectedNode(gw);
                                                  setIsDetailModalOpen(true);
                                                }}
                                                className="icon-action text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                                                title={t.usersPage.viewGatewayDetail}
                                              >
                                                <Eye className="w-3.5 h-3.5" />
                                              </button>
                                              <button
                                                type="button"
                                                onClick={() => handleDeleteNode(gw.id, gw.name)}
                                                className="icon-action text-slate-400 hover:text-rose-600"
                                                title={t.usersPage.deleteGateway}
                                              >
                                                <Trash2 className="w-3.5 h-3.5" />
                                              </button>
                                            </div>
                                          </div>
                                        </div>

                                        {/* Gateway Child Nodes Tree Area */}
                                        <div className="p-3 bg-white dark:bg-slate-900">
                                          {gw.childNodes.length === 0 ? (
                                            <div className="py-2.5 px-3 text-xs text-slate-400 italic bg-slate-50/50 dark:bg-slate-950/30 rounded border border-dashed border-slate-200/60 dark:border-slate-800">
                                              {t.usersPage.gatewayAwaitingNodes}
                                            </div>
                                          ) : (
                                            <div className="space-y-1.5 pl-3 border-l-2 border-slate-200 dark:border-slate-800 ml-3.5 my-1">
                                              <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 pb-0.5">
                                                {t.usersPage.nodesViaGatewayTitle.replace("{{count}}", String(gw.childNodes.length))}
                                              </div>
                                              {gw.childNodes.map((cn) => {
                                                const tel = cn.latest_telemetry;
                                                return (
                                                  <div
                                                    key={cn.id}
                                                    className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 p-2.5 rounded-lg border border-slate-100 dark:border-slate-800/80 bg-slate-50/40 dark:bg-slate-950/30 hover:bg-slate-50 dark:hover:bg-slate-900/60 transition text-xs"
                                                  >
                                                    {/* Node Identity */}
                                                    <div className="flex items-center gap-2.5 min-w-0">
                                                      <Cpu className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                                                      <div className="min-w-0">
                                                        <div className="flex items-center gap-2">
                                                          <span className="font-semibold text-slate-900 dark:text-slate-100 truncate">
                                                            {cn.name || cn.id}
                                                          </span>
                                                          <span className="text-[10px] font-mono text-slate-400 truncate">
                                                            {cn.id}
                                                          </span>
                                                        </div>
                                                        <div className="text-[11px] text-slate-500 truncate">
                                                          {cn.zone
                                                            ? `${cn.zone.name} ${
                                                                cn.zone.crop_type
                                                                  ? `(${cn.zone.crop_type})`
                                                                  : ""
                                                              }`
                                                            : t.usersPage.unassignedZone}
                                                        </div>
                                                      </div>
                                                    </div>

                                                    {/* Telemetry metrics & status in a clean horizontal strip */}
                                                    <div className="flex flex-wrap items-center gap-3 shrink-0 ml-auto sm:ml-0 text-[11px]">
                                                      <div className="flex items-center gap-2 text-slate-600 dark:text-slate-300 font-medium">
                                                        <span>
                                                          {t.usersPage.soilMoistureLabel}
                                                          <strong className="text-slate-800 dark:text-slate-200">
                                                            {tel?.soil_moisture != null
                                                              ? `${tel.soil_moisture}%`
                                                              : "--"}
                                                          </strong>
                                                        </span>
                                                        <span className="text-slate-300 dark:text-slate-700">·</span>
                                                        <span>
                                                          {t.usersPage.airTempLabel}
                                                          <strong className="text-slate-800 dark:text-slate-200">
                                                            {tel?.air_temp != null
                                                              ? `${tel.air_temp}°C`
                                                              : "--"}
                                                          </strong>
                                                        </span>
                                                      </div>

                                                      <span
                                                        className={`status-chip ${
                                                          cn.online
                                                            ? "status-chip--success"
                                                            : "status-chip--neutral"
                                                        }`}
                                                      >
                                                        {cn.online ? "Online" : "Offline"}
                                                      </span>

                                                      {/* Location button */}
                                                      {cn.latitude && cn.longitude ? (
                                                        <button
                                                          type="button"
                                                          onClick={() => {
                                                            setSelectedNode(cn);
                                                            setIsEditLocationOpen(true);
                                                          }}
                                                          className="text-[11px] font-mono text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
                                                          title={t.usersPage.editGpsTooltip}
                                                        >
                                                          {cn.latitude.toFixed(3)}, {cn.longitude.toFixed(3)}
                                                        </button>
                                                      ) : (
                                                        <button
                                                          type="button"
                                                          onClick={() => {
                                                            setSelectedNode(cn);
                                                            setIsEditLocationOpen(true);
                                                          }}
                                                          className="text-[11px] text-slate-400 hover:text-slate-600"
                                                        >
                                                          + GPS
                                                        </button>
                                                      )}

                                                      {/* Actions */}
                                                      <div className="flex items-center gap-0.5 border-l border-slate-200 dark:border-slate-800 pl-1.5">
                                                        <button
                                                          type="button"
                                                          onClick={() => {
                                                            setSelectedNode(cn);
                                                            setIsDetailModalOpen(true);
                                                          }}
                                                          className="icon-action text-slate-400 hover:text-slate-700"
                                                          title={t.usersPage.nodeDetailAria}
                                                        >
                                                          <Eye className="w-3.5 h-3.5" />
                                                        </button>
                                                        <button
                                                          type="button"
                                                          onClick={() =>
                                                            handleDeleteNode(cn.id, cn.name)
                                                          }
                                                          className="icon-action text-slate-400 hover:text-rose-600"
                                                          title={t.usersPage.deleteNodeAria}
                                                        >
                                                          <Trash2 className="w-3.5 h-3.5" />
                                                        </button>
                                                      </div>
                                                    </div>
                                                  </div>
                                                );
                                              })}
                                            </div>
                                          )}
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              )}

                              {/* 2. NODE CẢM BIẾN KẾT NỐI ĐỘC LẬP (WIFI / 4G) */}
                              {u.standaloneNodes && u.standaloneNodes.length > 0 && (
                                <div className="space-y-3 pt-1">
                                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1">
                                    <div className="flex items-center gap-2">
                                      <Cpu className="w-3.5 h-3.5 text-slate-500" />
                                      <span className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                                        {t.usersPage.standaloneNetworkTitle.replace("{{count}}", String(u.standaloneNodes.length))}
                                      </span>
                                    </div>
                                    <span className="text-[11px] text-slate-400">
                                      {t.usersPage.standaloneNetworkHint}
                                    </span>
                                  </div>

                                  <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 divide-y divide-slate-100 dark:divide-slate-800/80 overflow-hidden shadow-2xs">
                                    {u.standaloneNodes.map((node) => {
                                      const tel = node.latest_telemetry;
                                      return (
                                        <div
                                          key={node.id}
                                          className="flex flex-col md:flex-row md:items-center justify-between gap-3 p-3 hover:bg-slate-50/50 dark:hover:bg-slate-800/30 transition text-xs"
                                        >
                                          <div className="flex items-center gap-2.5 min-w-0">
                                            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                                              <Cpu className="w-3.5 h-3.5" />
                                            </div>
                                            <div className="min-w-0">
                                              <div className="flex flex-wrap items-center gap-2">
                                                <span className="font-semibold text-slate-900 dark:text-white truncate">
                                                  {node.name || node.id}
                                                </span>
                                                <span className="status-chip status-chip--neutral text-[10px]">
                                                  {t.usersPage.standaloneBadge}
                                                </span>
                                              </div>
                                              <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-500 font-mono mt-0.5">
                                                <button
                                                  type="button"
                                                  onClick={() => handleCopy(node.id, `node-${node.id}`)}
                                                  className="hover:text-slate-800 dark:hover:text-slate-200 cursor-pointer flex items-center gap-1"
                                                  title={t.usersPage.copyNodeId}
                                                >
                                                  <span>ID: {node.id}</span>
                                                  {copiedField === `node-${node.id}` ? (
                                                    <Check className="w-2.5 h-2.5 text-emerald-600" />
                                                  ) : (
                                                    <Copy className="w-2.5 h-2.5 text-slate-400" />
                                                  )}
                                                </button>
                                                {node.farm && (
                                                  <span className="font-sans text-slate-600 dark:text-slate-400">
                                                    · {t.nodesPage.farmPrefix}{node.farm.name}
                                                  </span>
                                                )}
                                                {node.zone && (
                                                  <span className="font-sans text-slate-500">
                                                    · {t.nodesPage.zonePrefix}{node.zone.name}
                                                  </span>
                                                )}
                                              </div>
                                            </div>
                                          </div>

                                          {/* Telemetry & Actions */}
                                          <div className="flex flex-wrap items-center gap-3 shrink-0 ml-auto md:ml-0 text-[11px]">
                                            <div className="flex items-center gap-2 text-slate-600 dark:text-slate-300 font-medium">
                                              <span>
                                                {t.usersPage.soilMoistureLabel}
                                                <strong className="text-slate-800 dark:text-slate-200">
                                                  {tel?.soil_moisture != null
                                                    ? `${tel.soil_moisture}%`
                                                    : "--"}
                                                </strong>
                                              </span>
                                              <span className="text-slate-300 dark:text-slate-700">·</span>
                                              <span>
                                                {t.usersPage.airTempLabel}
                                                <strong className="text-slate-800 dark:text-slate-200">
                                                  {tel?.air_temp != null
                                                    ? `${tel.air_temp}°C`
                                                    : "--"}
                                                </strong>
                                              </span>
                                            </div>

                                            <span
                                              className={`status-chip ${
                                                node.online
                                                  ? "status-chip--success"
                                                  : "status-chip--neutral"
                                              }`}
                                            >
                                              {node.online ? "Online" : "Offline"}
                                            </span>

                                            {/* GPS */}
                                            {node.latitude && node.longitude ? (
                                              <button
                                                type="button"
                                                onClick={() => {
                                                  setSelectedNode(node);
                                                  setIsEditLocationOpen(true);
                                                }}
                                                className="text-[11px] font-mono text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 flex items-center gap-1"
                                                title={t.usersPage.editGpsTooltip}
                                              >
                                                <MapPin className="w-3 h-3 text-slate-400" />
                                                <span>
                                                  {node.latitude.toFixed(3)}, {node.longitude.toFixed(3)}
                                                </span>
                                              </button>
                                            ) : (
                                              <button
                                                type="button"
                                                onClick={() => {
                                                  setSelectedNode(node);
                                                  setIsEditLocationOpen(true);
                                                }}
                                                className="text-[11px] text-slate-400 hover:text-slate-600 flex items-center gap-1"
                                                title={t.usersPage.noGpsTooltip}
                                              >
                                                <MapPin className="w-3 h-3" />
                                                <span>{t.usersPage.noGps}</span>
                                              </button>
                                            )}

                                            {/* Actions */}
                                            <div className="flex items-center gap-1 border-l border-slate-200 dark:border-slate-800 pl-2">
                                              <button
                                                type="button"
                                                onClick={() => {
                                                  setSelectedNode(node);
                                                  setIsDetailModalOpen(true);
                                                }}
                                                className="icon-action text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                                                title={t.usersPage.viewDetailAria}
                                              >
                                                <Eye className="w-3.5 h-3.5" />
                                              </button>
                                              <button
                                                type="button"
                                                onClick={() =>
                                                  handleDeleteNode(node.id, node.name)
                                                }
                                                className="icon-action text-slate-400 hover:text-rose-600"
                                                title={t.usersPage.deleteNodeAria}
                                              >
                                                <Trash2 className="w-3.5 h-3.5" />
                                              </button>
                                            </div>
                                          </div>
                                        </div>
                                      );
                                    })}
                                  </div>
                                </div>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Footer */}
        <footer className="admin-panel__footer">
          <span>
            {t.usersPage.footerRealtimeNote}
          </span>
          <span className="text-slate-400">
            FarmOS Admin v1.0
          </span>
        </footer>
      </section>

      {/* Modal: Create User */}
      {isAddUserModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-xs">
          <div className="bg-white dark:bg-slate-900 rounded-xl max-w-md w-full p-5 shadow-xl border border-slate-200 dark:border-slate-800">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-slate-800">
              <h3 className="font-semibold text-sm text-slate-900 dark:text-white">
                {t.usersPage.createModalTitle}
              </h3>
              <button
                type="button"
                onClick={() => setIsAddUserModalOpen(false)}
                className="icon-action text-slate-400"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {formError && (
              <div className="my-3 p-2.5 admin-alert admin-alert--error text-xs">
                {formError}
              </div>
            )}

            <form onSubmit={handleCreateUser} className="space-y-3 mt-3.5 text-xs">
              <div>
                <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                  {t.usersPage.fullNameLabel}
                </label>
                <input
                  type="text"
                  placeholder={t.usersPage.fullNamePlaceholder}
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  className="field"
                />
              </div>

              <div>
                <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                  {t.usersPage.emailLabel}
                </label>
                <input
                  type="email"
                  required
                  placeholder="khachhang@example.com"
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                  className="field"
                />
              </div>

              <div>
                <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                  {t.usersPage.passwordLabel}
                </label>
                <input
                  type="password"
                  required
                  placeholder="••••••••"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  className="field"
                />
              </div>

              <div>
                <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                  {t.usersPage.roleLabel}
                </label>
                <select
                  value={newRole}
                  onChange={(e) => setNewRole(e.target.value as "USER" | "ADMIN")}
                  className="field"
                >
                  <option value="USER">{t.usersPage.userRoleDesc}</option>
                  <option value="ADMIN">{t.usersPage.adminRoleDesc}</option>
                </select>
              </div>

              <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-100 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => setIsAddUserModalOpen(false)}
                  className="action action-light"
                >
                  {t.usersPage.cancel}
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="action action-dark"
                >
                  {submitting ? t.usersPage.creating : t.usersPage.createModalConfirm}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal: Add/Assign Node */}
      <AddNodeModal
        isOpen={isAddNodeModalOpen}
        onClose={() => setIsAddNodeModalOpen(false)}
        onSuccess={() => {
          setIsAddNodeModalOpen(false);
          void loadUsers(true);
          window.dispatchEvent(new CustomEvent("farmos:node-updated"));
        }}
      />

      {/* Modal: Device Details */}
      <DeviceDetailModal
        isOpen={isDetailModalOpen}
        node={selectedNode}
        onClose={() => {
          setIsDetailModalOpen(false);
          setSelectedNode(null);
        }}
        onEditLocation={(node) => {
          setSelectedNode(node);
          setIsEditLocationOpen(true);
        }}
      />

      {/* Modal: Edit GPS */}
      <EditNodeLocationModal
        isOpen={isEditLocationOpen}
        node={selectedNode}
        onClose={() => {
          setIsEditLocationOpen(false);
          setSelectedNode(null);
        }}
        onSuccess={() => {
          setIsEditLocationOpen(false);
          setSelectedNode(null);
          void loadUsers(true);
          window.dispatchEvent(new CustomEvent("farmos:node-updated"));
        }}
      />
    </div>
  );
};
