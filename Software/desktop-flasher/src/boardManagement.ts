import type { BoardPreflight, BoardProbe } from './native';

type Selection = { mac: string; deviceId: string; releaseId: string };
type Actions = {
  probe(): Promise<BoardProbe>;
  inspect(): Promise<BoardPreflight>;
  remove(deviceId: string): Promise<void>;
};

// Run only after explicit confirmation. A swapped board or changed registration
// must not cause deletion of a different device; never start flashing here.
export async function prepareBoardForReflash(selection: Selection, actions: Actions): Promise<BoardPreflight> {
  const physical = await actions.probe();
  if (!physical.ok || physical.mac?.toLowerCase() !== selection.mac.toLowerCase()) {
    throw new Error('Board đã thay đổi; kiểm tra lại cổng USB trước khi xóa.');
  }
  const before = await actions.inspect();
  if (before.currentDeviceId !== selection.deviceId || before.release?.id !== selection.releaseId) {
    throw new Error('Danh tính hoặc firmware đã thay đổi; kiểm tra lại trước khi xóa.');
  }
  await actions.remove(selection.deviceId);
  const after = await actions.inspect();
  if (after.currentDeviceId) throw new Error('Server vẫn còn đăng ký thiết bị; chưa thể nạp lại.');
  return after;
}
