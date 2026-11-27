import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { usePreferences, type AppColors } from '../context/PreferencesContext';
import { useWorkspace } from '../context/WorkspaceContext';
import { farmAssistant, type AssistantReport } from '../services/farmAssistant';
import { WorkspaceHeader } from './WorkspaceHeader';
import { SimulationAnalysis } from '../components/SimulationAnalysis';

const message = (e: unknown) => e instanceof Error ? e.message : 'Không thể kết nối đến FarmOS.';
export function FarmAssistantScreen() {
  const { farms, selectedFarmId, selectFarm } = useWorkspace();
  const { colors, language } = usePreferences();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const en = language === 'en';
  const farm = farms.find(item => item.id === selectedFarmId);
  return <View style={styles.screen}>
    <WorkspaceHeader title={en ? 'Farm status' : 'Xem vườn'} />
    {farm ? <>
      <View style={styles.farmSelector}>
        {farms.length === 1 ? <Text style={styles.heading}>{farm.name}</Text> :
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
            {farms.map(item => <Pressable key={item.id} accessibilityRole="button"
              accessibilityState={{ selected: item.id === farm.id }} onPress={() => selectFarm(item.id)}
              style={[styles.chip, item.id === farm.id && styles.chipSelected]}>
              <Text style={[styles.chipText, item.id === farm.id && styles.selectedText]}>{item.name}</Text>
            </Pressable>)}
          </ScrollView>}
      </View>
      <FarmAssistantContent key={farm.id} farmId={farm.id} />
    </> : <Text style={styles.empty}>{en ? 'No farm selected.' : 'Chưa chọn được vườn.'}</Text>}
  </View>;
}

function FarmAssistantContent({ farmId }: { farmId: string }) {
  const { colors, language } = usePreferences(); const styles = useMemo(() => makeStyles(colors), [colors]); const en = language === 'en';
  const { devices, devicesLoading, devicesError, loadDevices } = useWorkspace();
  const farmDevices = devices.filter(device => device.is_activated && device.farm?.id === farmId);
  const simulation = farmId.startsWith('SIM_');
  const [report, setReport] = useState<AssistantReport | null>(null);
  const [reportError, setReportError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [reload, setReload] = useState(0);
  useFocusEffect(useCallback(() => { setReload(n => n + 1); }, []));
  useEffect(() => {
    if (simulation) return;
    let active = true;
    setRefreshing(true);
    setReportError('');
    farmAssistant.report(farmId)
      .then(data => { if (active) setReport(data); })
      .catch(error => { if (active) setReportError(message(error)); })
      .finally(() => { if (active) setRefreshing(false); });
    return () => { active = false; };
  }, [farmId, reload, simulation]);
  return <View style={styles.contentWrap}>
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setReload(n => n + 1); void loadDevices(false); }} tintColor={colors.primary} />}>
      {simulation ? <SimulationAnalysis farmId={farmId} /> : <>
        <View style={styles.card}>
          <Text style={styles.heading}>{en ? 'Garden readings' : 'Số đo trong vườn'}</Text>
          {devicesLoading && <ActivityIndicator color={colors.primary} />}
          {!!devicesError && <Text style={styles.error}>{devicesError}</Text>}
          {!devicesLoading && !devicesError && !farmDevices.length && <Text style={styles.muted}>{en ? 'No devices assigned to this farm.' : 'Vườn này chưa có thiết bị.'}</Text>}
          {farmDevices.map(device => <View key={device.id} style={styles.finding}>
            <View style={styles.row}>
              <Text style={[styles.subheading, styles.flex]}>{device.name || (device.type === 'GATEWAY' ? (en ? 'Gateway' : 'Trạm kết nối') : (en ? 'Sensor' : 'Thiết bị đo'))}</Text>
              <Text style={device.online ? styles.selectedText : styles.muted}>{device.online ? (en ? 'Online' : 'Đang kết nối') : (en ? 'Offline' : 'Mất kết nối')}</Text>
            </View>
            {!!device.zone?.name && <Text style={styles.muted}>{device.zone.name}</Text>}
            {device.latest_telemetry && <Text style={styles.muted}>{en ? 'Last reading' : 'Đo lần cuối'} · {new Date(device.latest_telemetry.timestamp).toLocaleString(en ? 'en' : 'vi-VN')}</Text>}
            {device.type === 'SENSOR_NODE' && <View style={styles.measureGrid}>
            {([
              ['soil_moisture', en ? 'Soil moisture' : 'Độ ẩm đất', '%'],
              ['soil_temp', en ? 'Soil temperature' : 'Nhiệt độ đất', '°C'],
              ['air_temp', en ? 'Air temperature' : 'Nhiệt độ không khí', '°C'],
              ['air_humidity', en ? 'Air humidity' : 'Độ ẩm không khí', '%'],
            ] as const).map(([field, label, unit]) => {
              const value = device.latest_telemetry?.[field];
              return <View key={field} style={styles.measureCell}>
                <Text style={styles.muted}>{label}</Text>
                <Text style={value == null ? styles.muted : styles.measureValue}>{value == null
                  ? (en ? 'No reading' : 'Chưa có số đo')
                  : value.toLocaleString(en ? 'en' : 'vi-VN', { maximumFractionDigits: 1 }) + ' ' + unit}</Text>
              </View>;
            })}</View>}
          </View>)}
        </View>
        <View style={styles.card}>
          <Text style={styles.heading}>{en ? "Watering and alerts" : "Tưới và cảnh báo"}</Text>
          {!report && !reportError && <ActivityIndicator color={colors.primary} />}
          {!!reportError && <Text accessibilityRole="alert" style={styles.error}>{reportError}</Text>}
          {report && <>
            <Text style={styles.muted}>{en ? 'Updated' : 'Cập nhật'} · {new Date(report.generatedAt).toLocaleString()}</Text>
            <Text style={styles.subheading}>{en ? 'Watering in the last 24 hours' : 'Tưới trong 24 giờ qua'}</Text>
            <Text style={styles.body}>{report.summary.irrigationCount === 0 ? (en ? 'No watering commands.' : 'Chưa có lệnh tưới.') : <>{report.summary.truncated ? '≥ ' : ''}{report.summary.irrigationCount} {en ? 'commands' : 'lệnh'} · {report.summary.completed} {en ? 'completed' : 'hoàn thành'} · {report.summary.failed} {en ? 'unsuccessful' : 'chưa thành công'}</>}</Text>
            <Text style={styles.muted}>{en ? 'Devices checked' : 'Thiết bị đã kiểm tra'} · {report.nodesChecked}</Text>
            {report.findings.map((finding, index) => <View key={index} style={styles.finding}>
              <Text style={styles.subheading}>{finding.title}</Text>
              <Text style={styles.body}>{finding.detail}</Text>
              {finding.observedAt && <Text style={styles.muted}>{new Date(finding.observedAt).toLocaleString()}</Text>}
            </View>)}
          </>}
        </View>
      </>}
    </ScrollView>
  </View>;
}

function makeStyles(c: AppColors) { return StyleSheet.create({ measureGrid: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 8 }, measureCell: { width: '50%', paddingVertical: 9, paddingRight: 8, gap: 4 }, measureValue: { color: c.text, fontSize: 22, fontWeight: '700', fontVariant: ['tabular-nums'] }, screen: { flex: 1, backgroundColor: c.background }, contentWrap: { flex: 1 }, sectionTabs: { flexDirection: 'row', marginHorizontal: 18, marginTop: 6, padding: 4, borderRadius: 12, backgroundColor: c.surfaceMuted }, sectionTab: { flex: 1, alignItems: 'center', paddingVertical: 10, borderRadius: 9 }, sectionTabActive: { backgroundColor: c.surface }, sectionTabText: { color: c.textMuted, fontSize: 13, fontWeight: '600' }, sectionTabTextActive: { color: c.primary, fontWeight: '700' }, statusBox: { backgroundColor: c.surfaceMuted, borderRadius: 12, padding: 14, gap: 4 }, statusTitle: { color: c.text, fontWeight: '700', fontSize: 15 }, statsRow: { flexDirection: 'row', gap: 10 }, stat: { flex: 1, borderColor: c.border, borderWidth: 1, borderRadius: 12, padding: 12, gap: 4 }, statValue: { color: c.text, fontSize: 20, fontWeight: '700' }, privacy: { color: c.textMuted, fontSize: 11, lineHeight: 16 }, answer: { backgroundColor: c.surfaceMuted, borderRadius: 12, padding: 12, gap: 7 }, row: { flexDirection: 'row', alignItems: 'center', gap: 8 }, flex: { flex: 1, gap: 3 }, addButton: { backgroundColor: c.primarySoft, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10 }, addButtonText: { color: c.primary, fontWeight: '700', fontSize: 12 }, summaryLine: { backgroundColor: c.surfaceMuted, borderRadius: 10, padding: 12, gap: 4 }, form: { borderTopWidth: 1, borderTopColor: c.border, paddingTop: 12, gap: 10 }, questionInput: { minHeight: 100, textAlignVertical: 'top' }, farmSelector: { paddingHorizontal: 18, paddingVertical: 10, gap: 7 }, chips: { gap: 8, paddingVertical: 3 }, chip: { borderWidth: 1, borderColor: c.border, borderRadius: 18, paddingHorizontal: 13, paddingVertical: 8 }, chipSelected: { backgroundColor: c.primarySoft, borderColor: c.primary }, chipText: { color: c.text, fontSize: 13 }, selectedText: { color: c.primary, fontWeight: '700' }, content: { padding: 18, paddingBottom: 40, gap: 14 }, card: { backgroundColor: c.surface, borderColor: c.border, borderWidth: 1, borderRadius: 16, padding: 16, gap: 10 }, heading: { color: c.text, fontWeight: '700', fontSize: 17 }, subheading: { color: c.text, fontWeight: '700', fontSize: 14 }, body: { color: c.text, fontSize: 14, lineHeight: 21 }, muted: { color: c.textMuted, fontSize: 12, lineHeight: 18 }, finding: { borderTopWidth: 1, borderTopColor: c.border, paddingTop: 10, gap: 4 }, input: { color: c.text, borderWidth: 1, borderColor: c.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, minHeight: 44 }, button: { backgroundColor: c.primary, borderRadius: 10, alignItems: 'center', padding: 12 }, buttonText: { color: '#fff', fontWeight: '700' }, disabled: { opacity: 0.5 }, error: { color: c.danger, fontSize: 13 }, empty: { color: c.textMuted, padding: 20 } }); }
