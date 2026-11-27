#!/usr/bin/env python3
"""
FarmOS - Mock Sensor Nodes & Gateway Telemetry Publisher
Mô phỏng 3 Node cảm biến và 1 Gateway phát dữ liệu MQTT thời gian thực.
"""

import time
import json
import random
import sys

try:
    import paho.mqtt.client as mqtt
except ImportError:
    print("Vui lòng cài đặt thư viện paho-mqtt: pip install paho-mqtt")
    sys.exit(1)

MQTT_BROKER = "localhost"
MQTT_PORT = 1883
FARM_ID = "F01"

# Danh sách 3 Node theo 3 Zone
NODES = [
    {"node_id": "NODE_Z01_01", "zone_id": "Z01", "soil_moisture": 42.0, "soil_temp": 26.5},
    {"node_id": "NODE_Z02_01", "zone_id": "Z02", "soil_moisture": 55.0, "soil_temp": 25.8},
    {"node_id": "NODE_Z03_01", "zone_id": "Z03", "soil_moisture": 38.5, "soil_temp": 27.2},
]

def on_connect(client, userdata, flags, rc):
    if rc == 0:
        print(f"[OK] Kết nối thành công tới MQTT Broker: {MQTT_BROKER}:{MQTT_PORT}")
        # Subscribe các topic command để lắng nghe lệnh điều khiển
        command_topic = f"farm/{FARM_ID}/zone/+/command"
        client.subscribe(command_topic)
        print(f"[SUB] Đang lắng nghe lệnh tại topic: {command_topic}")
    else:
        print(f"[LỖI] Kết nối thất bại với mã code: {rc}")

def on_message(client, userdata, msg):
    try:
        payload = json.loads(msg.payload.decode())
        print(f"\n[NHẬN LỆNH TƯỚI] Topic: {msg.topic}")
        print(f"Payload: {json.dumps(payload, indent=2)}")
        
        # Giả lập Gateway phản hồi ACK sau khi thực thi
        zone_id = msg.topic.split("/")[3]
        cmd_id = payload.get("commandId", "unknown")
        duration = payload.get("duration_sec", 10)
        
        print(f"-> Đang thực thi tưới Zone {zone_id} trong {duration}s...")
        time.sleep(2) # Giả lập độ trễ
        
        ack_topic = f"farm/{FARM_ID}/node/GATEWAY_01/ack"
        ack_payload = {
            "commandId": cmd_id,
            "zoneId": zone_id,
            "status": "COMPLETED",
            "measured_flow_liters": round(random.uniform(10.5, 18.2), 2),
            "error_code": 0,
            "timestamp": int(time.time())
        }
        client.publish(ack_topic, json.dumps(ack_payload))
        print(f"[GỬI ACK] Đã phản hồi ACK cho {cmd_id} về topic: {ack_topic}\n")
    except Exception as e:
        print(f"[LỖI XỬ LÝ LỆNH]: {e}")

def main():
    client = mqtt.Client(client_id="FarmOS_Simulator")
    client.on_connect = on_connect
    client.on_message = on_message

    try:
        client.connect(MQTT_BROKER, MQTT_PORT, 60)
        client.loop_start()
    except Exception as e:
        print(f"[LỖI] Không thể kết nối tới {MQTT_BROKER}:{MQTT_PORT}. Hãy đảm bảo Mosquitto đang chạy (docker-compose up -d).")
        print(f"Chi tiết: {e}")
        return

    print("\n--- BẮT ĐẦU PHÁT DỮ LIỆU CẢM BIẾN TELEMETRY (Nhấn Ctrl+C để dừng) ---")
    try:
        while True:
            for node in NODES:
                # Mô phỏng biến thiên độ ẩm (giảm dần theo thời gian nếu không tưới)
                node["soil_moisture"] = max(20.0, node["soil_moisture"] - random.uniform(0.05, 0.2))
                
                payload = {
                    "timestamp": int(time.time()),
                    "farmId": FARM_ID,
                    "zoneId": node["zone_id"],
                    "nodeId": node["node_id"],
                    "soil_moisture": round(node["soil_moisture"], 1),
                    "soil_temp": round(node["soil_temp"] + random.uniform(-0.2, 0.2), 1),
                    "air_temp": round(28.0 + random.uniform(-1.0, 1.5), 1),
                    "air_humidity": round(72.0 + random.uniform(-3.0, 3.0), 1),
                    "lux": int(15000 + random.uniform(-1000, 2000)),
                    "quality": 1
                }
                
                topic = f"farm/{FARM_ID}/node/{node['node_id']}/telemetry"
                client.publish(topic, json.dumps(payload))
                print(f"[TELEMETRY] Topic: {topic} | Đất: {payload['soil_moisture']}% | KK: {payload['air_temp']}°C / {payload['air_humidity']}%")
            
            # Giả lập Gateway phát status
            gw_topic = f"farm/{FARM_ID}/node/GATEWAY_01/status"
            gw_status = {
                "timestamp": int(time.time()),
                "online": True,
                "water_tank_level_pct": 85.0,
                "water_tank_safe": True,
                "rssi": -62,
                "active_valves": []
            }
            client.publish(gw_topic, json.dumps(gw_status))
            
            print("-" * 60)
            time.sleep(5) # Phát chu kỳ 5 giây/lần
    except KeyboardInterrupt:
        print("\nĐã dừng mô phỏng.")
        client.loop_stop()
        client.disconnect()

if __name__ == "__main__":
    main()
