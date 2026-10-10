# ToolTrace smart station (ESP32 + RFID)

A tool-crib kiosk. **Tap your badge, then tap a tool's tag**: the tool is checked out to you. **Tap a tool you have out**: it is returned. Press the red **Report a problem** button first and the tool is returned and quarantined.

The station decides nothing itself. Every tap goes to the ToolTrace API as a **signed MQTT message**. The API applies the same rules as the web app, including the calibration lockout, and the station shows the **signed answer**.

## Hardware

| Part | Pins |
|---|---|
| ESP32 DevKit | |
| MFRC522 RFID reader (SPI) | SDA→5, SCK→18, MOSI→23, MISO→19, RST→4, 3.3V, GND |
| SSD1306 OLED 128×64 (I2C, 0x3C) | SDA→21, SCL→22, VCC→3.3V, GND |
| LEDs: green, amber, red (220 Ω each) | 25, 27, 26 |
| Passive buzzer | 32 |
| Push button "Report a problem" | 33 to GND (internal pull-up) |

Parts cost roughly ₹700–900. You don't need any of it: the [Wokwi simulator](#run-it-in-the-wokwi-simulator-free) runs the same firmware in a browser.

## Message protocol

Each station publishes to `tooltrace/v1/stations/<station-id>/events` and listens on `.../replies`.

```jsonc
// station -> API
{"v":1,"seq":1760000000456,"type":"tap","uid":"C0FFEE99","flag":"ok","sig":"e38e...2076"}
// API -> station
{"seq":1760000000456,"ok":true,"led":"green","l1":"TW-0101 is yours","l2":"Due in 8 h","sig":"..."}
```

| Field | Meaning |
|---|---|
| `seq` | Wall-clock milliseconds from NTP, strictly increasing. The API rejects anything not higher than the last one it accepted (replays), and anything more than 5 minutes off. |
| `sig` | HMAC-SHA256 over `v1\|<station-id>\|<seq>\|<type>\|<uid>\|<flag>`. Replies are signed over `r1\|<station-id>\|<seq>\|<ok>\|<led>\|<l1>\|<l2>`. |
| key | 32 bytes, derived on the server as HKDF-SHA256(master key, salt = station ID, info = `tooltrace-station-key-v<version>`). It is never stored anywhere. Rotating a key means bumping the version. |

`test/vectors.json` pins down the exact bytes. The API's TypeScript tests and the C++ tests in `test/host` both check against it.

## Why a shared broker is safe

- **Forged taps are rejected.** Without the station key, a message can't be signed.
- **Captured messages can't be replayed.** Each sequence number is accepted once, and only within 5 minutes.
- **Fake replies are ignored.** A reply only counts if it is signed with the station's key and answers the station's last message, so nobody can make the screen say "Checked out" when it wasn't.
- **Rejected messages get no reply**, so an attacker learns nothing. They are recorded in the activity log (Stations page).
- **TLS** to the broker uses the Let's Encrypt roots in `include/root_ca.h`.

What a public demo broker does *not* hide: anyone subscribed can see badge and tag IDs go by. For a real deployment, use a private broker (HiveMQ Cloud's free tier) with a username and password per device, and access rules so each station can only publish its own events.

## Run it in the Wokwi simulator (free)

1. In ToolTrace, open **Stations** and **Add a station**. Copy the firmware settings it shows.
2. Your API must listen on the same broker as the simulator. The simplest choice is the public demo broker. In the API's environment, set:
   ```
   MQTT_URL=mqtts://broker.hivemq.com:8883
   STATION_MASTER_KEY=<the same key the station was created with>
   ```
3. Go to [wokwi.com](https://wokwi.com), create a new **ESP32** project, and add these files as tabs:
   - `sketch.ino`: the contents of `src/main.cpp`
   - `station_core.h`, `root_ca.h` (from `include/`)
   - `config.h`: `include/config.example.h`, with your station ID and key pasted in
   - replace `diagram.json` with `wokwi/diagram.json`, and add `wokwi/libraries.txt`
4. Press play. The screen shows **Ready** and your station name.
5. Click the RFID reader to choose a card, then **Tap**. The seeded demo data matches Wokwi's cards:

| Wokwi card | UID | In the demo |
|---|---|---|
| Key fob | C0:FF:EE:99 | Your badge (assign it to yourself on the People page) |
| Green | 11:22:33:44 | TW-0101 torque wrench |
| Yellow | 55:66:77:88 | MM-0201 multimeter |
| Red | AA:BB:CC:DD | TW-0103: calibration expired, shows **LOCKED** |
| NFC tag | 04:11:22:33:44:55:66 | VC-0301 caliper |
| Blue | 0A:0B:0C:0D | Unassigned: shows **Unknown tag**, then appears in the activity log so you can enrol it |

## No simulator either? Use the terminal station

```bash
npm run station -w apps/api -- --id <station-id> --key <station-key>
```

Press `k`, `g`, `y`, `r` or `n` to tap the same cards, and `p` to report a problem. The Stations page shows the exact command, ready to copy.

## Build and flash a real board

```bash
cd firmware/station
cp include/config.example.h include/config.h   # then fill it in
pio run -t upload && pio device monitor
```

## Tests

```bash
make -C firmware/station/test/host     # needs g++ and OpenSSL headers
```

These cover signing against the shared vectors, reply verification (tampered, flipped, replayed and wrong-key replies are all refused), hex parsing, the sequence clock surviving NTP adjustments, card debouncing, and the problem button surviving `millis()` wrap-around. CI also compiles the full ESP32 firmware with PlatformIO on every push.
