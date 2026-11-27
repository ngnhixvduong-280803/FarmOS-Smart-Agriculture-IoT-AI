import { useEffect, useState } from "react";
import { Power } from "lucide-react";
import { getPumpControl, sendPumpCommand, PumpControlStatus, PumpCommand } from "../services/api.service";
import { useI18n } from "../context/I18nContext";

const messages: Record<string, [string, string]> = {
  NOT_COMMISSIONED: ["Thiết bị chưa được cấu hình điều khiển bơm.", "Pump control has not been commissioned on this device."],
  NO_DEVICE_RESPONSE: ["Thiết bị chưa phản hồi hoặc firmware chưa hỗ trợ điều khiển bơm.", "The device is offline or its firmware does not support pump control."],
  UNSUPPORTED_DEVICE: ["Điều khiển bơm yêu cầu Node Wi-Fi độc lập.", "Pump control requires a standalone Wi-Fi Node."],
  DEVICE_INACTIVE: ["Thiết bị chưa kích hoạt hoặc đã bị thu hồi.", "The device is inactive or has been revoked."],
  DEVICE_NOT_FOUND: ["Bạn cần là chủ thiết bị hoặc quản trị viên để điều khiển bơm.", "Only the device owner or an administrator can control the pump."],
  DEVICE_RELEASING: ["Thiết bị đang được gỡ khỏi tài khoản.", "The device is being released from its account."],
  COMMAND_IN_PROGRESS: ["Thiết bị đang xử lý một lệnh bơm.", "The device is processing a pump command."],
  INTERLOCK_OPEN: ["Thiết bị từ chối bật vì khóa an toàn đang mở.", "The device refused to start because the safety interlock is open."],
  FEEDBACK_MISMATCH: ["Tín hiệu tiếp điểm không khớp với trạng thái yêu cầu. Kiểm tra tại chỗ.", "Contactor feedback does not match the requested state. Check the pump on site."],
  FEEDBACK_ALREADY_ON: ["Tiếp điểm đang báo bật. Thiết bị từ chối cấp lệnh bật mới.", "The contactor already reports ON. The device refused a new start."],
  OUTPUT_ERROR: ["Thiết bị báo lỗi ngõ ra điều khiển.", "The device reported a control output fault."],
  TIMEOUT: ["Hết thời gian chờ xác nhận. Chưa xác định được trạng thái bơm.", "Confirmation timed out. The pump state is unknown."],
  CANCELLED: ["Lệnh đã bị hủy. Kiểm tra phản hồi của lệnh mới nhất.", "The command was cancelled. Check the result of the latest command."],
  SESSION_EXPIRED: ["Phiên đăng nhập đã hết hạn.", "Your session has expired."],
  NETWORK_ERROR: ["Mất kết nối với máy chủ. Chưa xác định được trạng thái lệnh.", "Connection to the server was lost. The command state is unknown."],
  COMMAND_NOT_FOUND: ["Lệnh này không còn khả dụng với tài khoản hiện tại.", "This command is no longer available to the current account."],
  INVALID_COMMAND: ["Máy chủ từ chối lệnh vì dữ liệu không hợp lệ.", "The server rejected an invalid command."],
  RATE_LIMITED: ["Đã gửi quá nhiều yêu cầu. Vui lòng chờ rồi thử lại.", "Too many requests. Wait before trying again."],
  SERVER_UNAVAILABLE: ["Máy chủ điều khiển hiện chưa khả dụng.", "The pump control service is unavailable."],
};

function isPending(command: PumpCommand | null | undefined) {
  return command?.status === "PENDING" || command?.status === "DELIVERED";
}

export function DevicePumpControl({ nodeId }: { nodeId: string }) {
  const { language } = useI18n();
  const vi = language === "vi";
  const [state, setState] = useState<PumpControlStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [trackedCommandId, setTrackedCommandId] = useState<string>();
  const waiting = isPending(state?.command);
  const message = (code: string) => (messages[code] ?? messages.SERVER_UNAVAILABLE)[vi ? 0 : 1];

  useEffect(() => {
    if (sending) return;
    const controller = new AbortController();
    let timer: number;
    const refresh = async () => {
      try {
        const data = await getPumpControl(nodeId, controller.signal, trackedCommandId);
        if (!controller.signal.aborted) {
          setState(data);
          setPollError(null);
        }
      } catch (cause) {
        if (!controller.signal.aborted) setPollError(cause instanceof Error ? cause.message : "NETWORK_ERROR");
      } finally {
        if (!controller.signal.aborted) timer = window.setTimeout(refresh, waiting ? 1500 : 12_000);
      }
    };
    void refresh();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [nodeId, waiting, sending, trackedCommandId]);

  const submit = async (on: boolean) => {
    setSending(true);
    setError(null);
    try {
      const command = await sendPumpCommand(nodeId, on, crypto.randomUUID());
      setTrackedCommandId(command.id);
      setState(current => current && { ...current, command });
    } catch (cause) {
      setTrackedCommandId(undefined);
      setError(cause instanceof Error ? cause.message : "NETWORK_ERROR");
    } finally {
      setSending(false);
    }
  };

  const command = state?.command;
  const disabled = sending || !state || Boolean(state.reason || pollError);
  const confirmed = command?.status === "CONFIRMED";
  const commandError = command?.status === "FAILED" ? command.error ?? "OUTPUT_ERROR" :
    command?.status === "TIMEOUT" || command?.status === "CANCELLED" ? command.status : null;
  const button = "min-h-10 rounded-lg border px-4 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-40";

  return (
    <section className="mb-4 rounded-xl border border-slate-200 p-4 dark:border-slate-700">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-white">
        <Power size={16} /> {vi ? "Điều khiển bơm" : "Pump control"}
      </h3>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className={`${button} border-emerald-700 bg-emerald-700 text-white`} disabled={disabled || waiting} onClick={() => void submit(true)}>
          {vi ? `Bật bơm${state ? ` · ${state.runSeconds} giây` : ""}` : `Start pump${state ? ` · ${state.runSeconds}s` : ""}`}
        </button>
        <button type="button" className={`${button} border-rose-300 text-rose-700 dark:border-rose-800 dark:text-rose-300`} disabled={disabled || (waiting && command?.on === false)} onClick={() => void submit(false)}>
          {vi ? "Tắt bơm" : "Stop pump"}
        </button>
      </div>
      <div aria-live="polite" className="mt-3 space-y-1 text-xs text-slate-600 dark:text-slate-300">
        {!state && !pollError && <p>{vi ? "Đang kiểm tra kết nối điều khiển…" : "Checking pump connection…"}</p>}
        {state?.reason && <p>{message(state.reason)}</p>}
        {(sending || waiting) && <p>{vi ? "Đang chờ thiết bị xác nhận…" : "Waiting for device confirmation…"}</p>}
        {confirmed && <p className="text-emerald-700 dark:text-emerald-400">
          {vi ? "Thiết bị đã xác nhận tiếp điểm" : "Device confirmed contactor"} {command.feedbackOn ? (vi ? "BẬT" : "ON") : (vi ? "TẮT" : "OFF")}
          {command.confirmedAt && ` · ${new Date(command.confirmedAt).toLocaleString(vi ? "vi-VN" : "en-US")}`}
          {command.feedbackOn && (vi ? ` · lệnh tự ngắt sau tối đa ${state?.runSeconds} giây` : ` · automatic cutoff within ${state?.runSeconds}s`)}
        </p>}
        {pollError && <p className="text-red-700 dark:text-red-400">{message(pollError)}</p>}
        {error && <p className="text-red-700 dark:text-red-400">{message(error)}</p>}
        {commandError && <p className="text-red-700 dark:text-red-400">{message(commandError)}</p>}
      </div>
    </section>
  );
}
