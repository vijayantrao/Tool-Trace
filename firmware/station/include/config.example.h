// Copy this file to include/config.h and fill it in. config.h is git-ignored.
// For the Wokwi simulator, paste the filled-in version as a "config.h" tab.
#pragma once

// ---- Wi-Fi. In Wokwi use "Wokwi-GUEST" with an empty password.
#define WIFI_SSID "Wokwi-GUEST"
#define WIFI_PASSWORD ""

// ---- MQTT broker.
// Production: your HiveMQ Cloud cluster, TLS on port 8883 with a device username/password.
// Demo:       broker.hivemq.com, TLS on 8883, no username. Public: anyone can read the traffic,
//             but nobody can forge it, because every message and reply is signed.
#define MQTT_HOST "broker.hivemq.com"
#define MQTT_PORT 8883
#define MQTT_TLS 1          // 1 = verify the broker's certificate (Let's Encrypt roots). 0 = plain, local only.
#define MQTT_USERNAME ""    // leave empty if the broker needs no login
#define MQTT_PASSWORD ""

// ---- Station identity. Paste the block shown once in ToolTrace > Stations when you
// create the station (or rotate its key). Keep it secret.
#define STATION_ID "00000000-0000-0000-0000-000000000000"
#define STATION_KEY_HEX "0000000000000000000000000000000000000000000000000000000000000000"
#define MQTT_TOPIC_PREFIX "tooltrace/v1"
