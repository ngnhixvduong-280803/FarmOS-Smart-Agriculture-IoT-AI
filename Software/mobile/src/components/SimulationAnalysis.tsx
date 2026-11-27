import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Line, Polyline, Text as SvgText } from 'react-native-svg';
import { useIsFocused } from '@react-navigation/native';
import { usePreferences, type AppColors } from '../context/PreferencesContext';
import { getAllSimulationAnalyses, getSimulationAnalysis, type SimulationFarm, type SimulationNode, type SimulationPlan } from '../services/farmAssistant';
const crops: Record<string, string> = { chilli: 'Ớt', tomato: 'Cà chua', 'mustard-greens': 'Cải xanh' };
const soils: Record<string, string> = { silt: 'Đất thịt bụi', 'loamy-sand': 'Đất cát pha', 'silty-clay': 'Đất sét pha bụi' };
const sensors: Record<string, [string, string]> = { soil_moisture: ['Độ ẩm đất', '% VWC'], soil_temp: ['Nhiệt độ đất', '°C'], air_temp: ['Nhiệt độ không khí', '°C'], air_humidity: ['Độ ẩm không khí', '%'], lux: ['Ánh sáng', 'lux'] };
const num = (value: number) => value.toLocaleString('vi-VN', { maximumFractionDigits: 1 });
const when = (ms: number) => new Date(ms).toLocaleString('vi-VN');
function Plan({ title, plan, styles, showOptions }: { title: string; showOptions: boolean; plan?: SimulationPlan; styles: ReturnType<typeof makeStyles> }) {
 if (!plan) return <Text style={styles.body}>{title}: Chưa đủ dữ liệu thời tiết hoặc số đo.</Text>;
 const best = plan.options[0];
 return <View style={styles.panel}><Text style={styles.subheading}>{title}</Text><Text style={styles.body}>{plan.unresolved ? 'Chưa đủ căn cứ để chốt lịch tưới.' : !best || best.delay === null ? 'Chưa cần lên lịch tưới.' : `Dự kiến ${when(plan.startsAt + best.delay * 3600_000)} · ${num(best.mm)} lít/m².`}</Text><Text style={styles.muted}>Mưa dự báo {num(plan.rainMm)} mm · Cập nhật {when(plan.fetchedAt)}. {plan.reason}</Text>{showOptions && plan.options.map((option, i) => <Text key={i} style={styles.muted}>{option.delay === null ? 'Chờ' : `Tưới ${when(plan.startsAt + option.delay * 3600_000)}`}: {num(option.mm)} lít/m² · thiếu ẩm {option.dryHours} giờ · ẩm cao {option.wetHours} giờ</Text>)}</View>;
}
function NodeCard({ node, styles }: { node: SimulationNode; styles: ReturnType<typeof makeStyles> }) {
 const [expanded, setExpanded] = useState(false);
 if (node.agentSnapshot) return <AgentNodeCard node={node} styles={styles} />;
 return <View style={styles.node}><Text style={styles.subheading}>{crops[node.crop] || node.crop} · {soils[node.soil] || node.soil}</Text>
  <Text style={styles.subheading}>Số đo · mới nhất / trung bình 24 giờ mô phỏng</Text>{node.sensors?.filter(sensor => sensor.field !== "lux").map(s => <Text key={s.field} style={styles.body}>{sensors[s.field]?.[0] || s.field}: {s.current === null ? '—' : num(s.current)} / {s.average === null ? '—' : num(s.average)} {sensors[s.field]?.[1] || ''} ({s.count}/24 mẫu)</Text>)}
  <Text style={styles.body}>{node.recommendation}</Text>
  <Pressable accessibilityRole="button" accessibilityState={{ expanded }} onPress={() => setExpanded(value => !value)}>
    <Text style={styles.link}>{expanded ? 'Thu gọn phân tích' : 'Xem chi tiết phân tích'}</Text>
  </Pressable>
  {expanded && <View style={styles.panel}><Text style={styles.muted}>{node.nodeId} · {node.samples} mẫu/giờ · nhận {when(Date.parse(node.receivedAt))}</Text>{!node.usable && <Text style={styles.warning}>{node.qualityReason || 'Dữ liệu chưa đáng tin cậy; cần kiểm tra trước khi đánh giá.'}</Text>}{node.moisture !== undefined && <Text style={styles.body}>Độ ẩm {num(node.moisture)}% VWC{node.threshold !== undefined ? ` · ngưỡng tham chiếu ${num(node.threshold)}%` : ''}</Text>}{node.weatherUnavailable && <Text style={styles.warning}>Chưa có dự báo thời tiết.</Text>}{node.rapidDrying && <Text style={styles.warning}>Đất khô nhanh: giảm {num(node.rapidDrying.drop)} điểm trong 6 giờ; thông thường {num(node.rapidDrying.typicalDrop)} điểm. Kiểm tra luống và nước chảy tràn.</Text>}{node.wetNow && <Text style={styles.warning}>Đất ẩm cao vượt {num(node.wetNow.threshold)}% trong {node.wetNow.hours} giờ mô phỏng. Kiểm tra thoát nước.</Text>}{node.irrigationResponse && <Text style={styles.body}>Sau lần tưới ảo {num(node.irrigationResponse.mm)} lít/m², độ ẩm từ {num(node.irrigationResponse.before)}% đến {num(node.irrigationResponse.after)}% · trạng thái {({ no_response:'không tăng rõ', rapid_loss:'mất ẩm nhanh', wet:'ẩm cao', responded:'đã tăng' } as Record<string,string>)[node.irrigationResponse.status] || node.irrigationResponse.status}.</Text>}{node.soilRecommendation && <Text style={styles.body}>{node.soilRecommendation}</Text>}
 </View>}
  <Plan title="Lịch tưới 24 giờ" plan={node.irrigationPlan} styles={styles} showOptions={expanded}/><Plan title="Lịch tưới ngày mai" plan={node.tomorrowPlan} styles={styles} showOptions={expanded}/>{expanded && node.models && <View style={styles.panel}><Text style={styles.subheading}>Kiểm thử dự báo sau {node.models.horizon} giờ</Text>{node.models.candidates.map(m => <Text key={m.name} style={styles.body}>{m.name}: {num(m.forecast)}% VWC · MAE {m.mae.toFixed(2)} · {node.models!.testCount} mẫu</Text>)}</View>}</View>;
}
const forecastTime = (timestamp: number) => new Date(timestamp).toLocaleString('vi-VN', {
  timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit',
});

function AgentNodeCard({ node, styles }: { node: SimulationNode; styles: ReturnType<typeof makeStyles> }) {
  const { colors } = usePreferences();
  const [showWeek, setShowWeek] = useState(false);
  const [showStatus, setShowStatus] = useState(false);
  const agent = node.agentSnapshot!;
  const usable = node.usable !== false && agent.quality === 'ready' && agent.deviceHealth.status === 'online';
  const dry = agent.irrigation.action === 'inspect_dry_soil';
  const plan = usable ? agent.forecastSchedule.plan24h?.result : undefined;
  const selected = plan?.selected;
  const weekly = agent.forecastSchedule.weekly?.forecast;
  const points = weekly?.trajectory ?? [];
  const threshold = weekly?.threshold;
  const values = points.flatMap(point => [point.withRain, point.withoutRain]);
  const low = Math.floor(Math.min(...values, threshold ?? 0) - 2);
  const high = Math.ceil(Math.max(...values, threshold ?? 0) + 2);
  const x = (i: number) => 32 + i * 268 / Math.max(1, points.length - 1);
  const y = (value: number) => 117 - (value - low) * 101 / Math.max(1, high - low);
  const title = !usable ? 'Cần kiểm tra cảm biến' : dry ? 'Đất đang khô · cần kiểm tra'
    : agent.irrigation.action === 'consider_waiting_for_rain' ? 'Có thể chờ mưa' : 'Tiếp tục theo dõi';
  const followup = agent.irrigationFollowup;

  return <View style={styles.node}>
    <Text style={styles.subheading}>{crops[node.crop] ?? node.crop} · {soils[node.soil] ?? node.soil}</Text>
    <View style={styles.panel}>
      <Text accessibilityRole="header" style={usable && !dry ? styles.heading : styles.warningHeading}>{title}</Text>
      <Text style={styles.body}>{usable ? agent.irrigation.reason : 'Kiểm tra kết nối và cảm biến trước khi quyết định tưới.'}</Text>
      <Text style={styles.muted}>Hệ thống đưa ra đề xuất. Bạn quyết định việc tưới.</Text>
    </View>
    <View style={styles.readings}>
      {node.sensors?.filter(sensor => sensor.field !== 'lux').map(sensor => <View key={sensor.field} style={styles.reading}>
        <Text style={styles.muted}>{sensors[sensor.field]?.[0] ?? sensor.field}</Text>
        <Text style={styles.heading}>{sensor.current == null ? '—' : `${num(sensor.current)} ${sensors[sensor.field]?.[1] ?? ''}`}</Text>
      </View>)}
    </View>
    <View style={styles.panel}>
      <Text accessibilityRole="header" style={styles.subheading}>Kế hoạch tưới 24 giờ</Text>
      <Text style={styles.body}>{!usable ? 'Chờ số đo đáng tin cậy để tính kế hoạch.'
        : plan?.status !== 'ready' || !selected ? 'Đang chờ số đo và dự báo thời tiết để cập nhật.'
        : selected.delayHours === null ? (dry ? 'Chưa có giờ tưới đề xuất. Kiểm tra đất tại chỗ trước khi quyết định.' : 'Theo dõi, chưa cần tưới theo mô hình.')
        : plan.startsAt != null ? `Cân nhắc tưới ${num(selected.mm)} lít/m² lúc ${forecastTime(plan.startsAt + selected.delayHours * 3600_000)}.` : 'Đang cập nhật giờ tưới đề xuất.'}</Text>
      <Text style={styles.muted}>{agent.weather.status === 'ready' && agent.weather.rainMm24h != null
        ? `Mưa dự báo ${num(agent.weather.rainMm24h)} mm trong 24 giờ.`
        : 'Chưa có dự báo thời tiết cho vị trí vườn.'}</Text>
    </View>
    {usable && weekly?.status === 'ready' && points.length > 1 && threshold != null && <>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: showWeek }} onPress={() => setShowWeek(value => !value)}>
        <Text style={styles.link}>{showWeek ? 'Thu gọn dự báo độ ẩm 7 ngày' : 'Xem dự báo độ ẩm 7 ngày'}</Text>
      </Pressable>
      {showWeek && <View style={styles.panel}>
        <Text style={styles.muted}>Độ ẩm đất nếu chưa tưới · % VWC</Text>
        <Svg width="100%" height={154} viewBox="0 0 320 150" accessible accessibilityLabel="Dự báo độ ẩm đất 7 ngày với mưa và không mưa">
          {[0, 1, 2].map(index => {
            const value = low + index * (high - low) / 2;
            return <React.Fragment key={index}>
              <Line x1={32} x2={300} y1={y(value)} y2={y(value)} stroke={colors.border} />
              <SvgText x={27} y={y(value) + 3} textAnchor="end" fontSize={10} fill={colors.textMuted}>{num(value)}</SvgText>
            </React.Fragment>;
          })}
          <Line x1={32} x2={300} y1={y(threshold)} y2={y(threshold)} stroke={colors.warning} strokeDasharray="4 4" />
          <Polyline points={points.map((point, index) => `${x(index)},${y(point.withRain)}`).join(' ')} stroke={colors.primary} strokeWidth={2.5} fill="none" />
          <Polyline points={points.map((point, index) => `${x(index)},${y(point.withoutRain)}`).join(' ')} stroke="#5188bd" strokeWidth={2.5} strokeDasharray="5 3" fill="none" />
          {points.map((point, index) => index % 2 === 0 || index === points.length - 1
            ? <SvgText key={point.at} x={x(index)} y={137} textAnchor="middle" fontSize={10} fill={colors.textMuted}>
                {new Date(point.at).toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit' })}
              </SvgText> : null)}
        </Svg>
        <Text style={styles.body}>Có mưa · nét liền · {weekly.firstBelowWithRain == null ? 'Chưa xuống ngưỡng' : `Kiểm tra đất từ ${forecastTime(weekly.firstBelowWithRain)}`}</Text>
        <Text style={styles.body}>Không mưa · nét đứt · {weekly.firstBelowWithoutRain == null ? 'Chưa xuống ngưỡng' : `Kiểm tra đất từ ${forecastTime(weekly.firstBelowWithoutRain)}`}</Text>
        <Text style={styles.muted}>Ngưỡng tham chiếu {num(threshold)}% VWC · Tính lại lúc 06:00 giờ Việt Nam.</Text>
      </View>}
    </>}
    <Pressable accessibilityRole="button" accessibilityState={{ expanded: showStatus }} onPress={() => setShowStatus(value => !value)}>
      <Text style={styles.link}>{showStatus ? 'Thu gọn tình trạng hệ thống' : 'Xem tình trạng hệ thống'}</Text>
    </Pressable>
    {showStatus && <View style={styles.panel}>
      <Text style={styles.body}>Thiết bị {agent.deviceHealth.status === 'online' ? 'đang gửi mẫu' : 'chưa có mẫu mới'} · Cập nhật {forecastTime(agent.generatedAt)}</Text>
      {agent.forecastSchedule.lastCheck && <Text style={styles.body}>Kiểm tra kế hoạch lúc {forecastTime(agent.forecastSchedule.lastCheck.checkedAt)}</Text>}
      {followup.status === 'compared' && followup.before != null && followup.after != null && <Text style={styles.body}>
        Sau lần tưới mô phỏng, độ ẩm đất đổi từ {num(followup.before)}% sang {num(followup.after)}% VWC.
      </Text>}
    </View>}
  </View>;
}
export function SimulationAnalysis({ farmId }: { farmId?: string }) {
 const { colors } = usePreferences(); const styles = useMemo(() => makeStyles(colors), [colors]); const focused = useIsFocused(); const [farms, setFarms] = useState<SimulationFarm[]>([]); const [loading, setLoading] = useState(true); const [error, setError] = useState(''); const [version, setVersion] = useState(0);
 const [selectedId, setSelectedId] = useState<string>();
 const selected = farms.find(farm => farm.id === selectedId) ?? farms[0];
 const refresh = useCallback(() => setVersion(n => n + 1), []);
 useEffect(() => { if (!focused) return; let active = true; let timer: ReturnType<typeof setTimeout>; async function load() { try { const response = farmId ? [await getSimulationAnalysis(farmId)].filter((farm): farm is SimulationFarm => farm !== null) : await getAllSimulationAnalyses(); if (active) { setFarms(response); setError(''); } } catch { if (active) setError('Không tải được phân tích mới. Kiểm tra kết nối và phiên bản server.'); } finally { if (active) { setLoading(false); timer = setTimeout(load, 10000); } } } void load(); return () => { active = false; clearTimeout(timer); }; }, [farmId, focused, version]);
 return (
   <View style={styles.card}>
     <Text style={styles.heading}>Phân tích vườn mô phỏng</Text>
     <Text style={styles.muted}>Dữ liệu tổng hợp, không phải số đo ngoài thực địa. Không dùng trực tiếp để điều khiển tưới thật.</Text>
     {loading && <ActivityIndicator color={colors.primary} />}
     {!!error && (
       <Text accessibilityRole="alert" style={styles.warning}>
         {error}{selected ? ' Đang chờ kết quả mới.' : ''}
       </Text>
     )}
     {!loading && !error && !selected?.nodes.length && (
       <Text style={styles.body}>Chưa có số đo mô phỏng cho vườn này.</Text>
     )}
     {farms.length > 1 && (
       <View style={styles.choices}>
         {farms.map(farm => (
           <Pressable
             key={farm.id}
             accessibilityRole="button"
             accessibilityState={{ selected: farm.id === selected?.id }}
             onPress={() => setSelectedId(farm.id)}
             style={[styles.panel, farm.id === selected?.id && styles.selected]}
           >
             <Text style={styles.body}>{farm.name}</Text>
           </Pressable>
         ))}
       </View>
     )}
     {!error && selected?.nodes.map(node => <NodeCard key={node.nodeId} node={node} styles={styles} />)}
     <Pressable accessibilityRole="button" onPress={refresh}>
       <Text style={styles.link}>Làm mới phân tích</Text>
     </Pressable>
   </View>
 );
}
function makeStyles(c: AppColors) { return StyleSheet.create({ readings:{ flexDirection:'row', flexWrap:'wrap', gap:8 }, reading:{ width:'47%', paddingVertical:6 }, warningHeading:{ color:c.warning, fontSize:17, fontWeight:'700' }, choices:{ flexDirection:"row", flexWrap:"wrap", gap:8 }, selected:{ borderWidth:1, borderColor:c.primary }, card:{ backgroundColor:c.surface, borderColor:c.border, borderWidth:1, borderRadius:16, padding:16, gap:10 }, heading:{ color:c.text, fontSize:17, fontWeight:'700' }, subheading:{ color:c.text, fontSize:14, fontWeight:'700' }, body:{ color:c.text, fontSize:13, lineHeight:20 }, muted:{ color:c.textMuted, fontSize:12, lineHeight:18 }, warning:{ color:c.warning, fontSize:13, lineHeight:19 }, panel:{ backgroundColor:c.surfaceMuted, borderRadius:10, padding:10, gap:5 }, node:{ borderTopWidth:1, borderTopColor:c.border, paddingTop:12, gap:8 }, link:{ color:c.primary, fontWeight:'700', paddingVertical:8 } }); }
