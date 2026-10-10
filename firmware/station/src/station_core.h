// ToolTrace station core: everything that decides *what* the station sends and
// *whether* to trust a reply, with no Arduino dependencies. The same file is
// compiled for the ESP32 and for the host unit tests (test/host), which check
// it against test/vectors.json, the vectors the API's TypeScript tests also use.
//
// C++11 only, so it builds with every ESP32 Arduino core.
#pragma once

#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <string>

namespace tt {

// HMAC-SHA256 provider: mbedtls on the ESP32, OpenSSL in host tests.
typedef void (*HmacFn)(const uint8_t* key, size_t keyLen, const uint8_t* msg, size_t msgLen, uint8_t out[32]);

// ---------------------------------------------------------------- hex helpers

inline std::string toHex(const uint8_t* data, size_t len, bool upper = false) {
  static const char* lo = "0123456789abcdef";
  static const char* up = "0123456789ABCDEF";
  const char* digits = upper ? up : lo;
  std::string out;
  out.reserve(len * 2);
  for (size_t i = 0; i < len; i++) {
    out.push_back(digits[data[i] >> 4]);
    out.push_back(digits[data[i] & 0x0f]);
  }
  return out;
}

inline int hexValue(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

// Parses exactly outLen bytes. Returns false on any malformed input.
inline bool fromHex(const char* hex, uint8_t* out, size_t outLen) {
  for (size_t i = 0; i < outLen; i++) {
    int hi = hexValue(hex[i * 2]);
    int lo = hex[i * 2] ? hexValue(hex[i * 2 + 1]) : -1;
    if (hi < 0 || lo < 0) return false;
    out[i] = static_cast<uint8_t>((hi << 4) | lo);
  }
  return hex[outLen * 2] == '\0';
}

// RFID UID bytes -> "C0FFEE99" (the server's normalised form).
inline std::string uidHex(const uint8_t* uid, size_t len) { return toHex(uid, len, true); }

// --------------------------------------------------------- signed messages

// Must match canonical() in apps/api/src/stations/crypto.ts byte for byte.
inline std::string canonicalEvent(const std::string& stationId, uint64_t seq, const std::string& type,
                                  const std::string& uid, const std::string& flag) {
  char seqBuf[24];
  snprintf(seqBuf, sizeof seqBuf, "%llu", static_cast<unsigned long long>(seq));
  return "v1|" + stationId + "|" + seqBuf + "|" + type + "|" + uid + "|" + flag;
}

// Must match replyCanonical() in apps/api/src/stations/gateway.ts.
inline std::string canonicalReply(const std::string& stationId, uint64_t seq, bool ok, const std::string& led,
                                  const std::string& l1, const std::string& l2) {
  char seqBuf[24];
  snprintf(seqBuf, sizeof seqBuf, "%llu", static_cast<unsigned long long>(seq));
  return "r1|" + stationId + "|" + seqBuf + "|" + (ok ? "1" : "0") + "|" + led + "|" + l1 + "|" + l2;
}

inline std::string signHex(HmacFn hmac, const uint8_t* key, size_t keyLen, const std::string& msg) {
  uint8_t mac[32];
  hmac(key, keyLen, reinterpret_cast<const uint8_t*>(msg.data()), msg.size(), mac);
  return toHex(mac, sizeof mac);
}

// Compares in constant time so a forger can't learn the signature byte by byte.
inline bool constantTimeEquals(const std::string& a, const std::string& b) {
  if (a.size() != b.size()) return false;
  unsigned char diff = 0;
  for (size_t i = 0; i < a.size(); i++) diff |= static_cast<unsigned char>(a[i] ^ b[i]);
  return diff == 0;
}

// Only these characters can appear in the fields we sign, so no JSON escaping is ever needed.
inline bool isSafeToken(const std::string& s) {
  for (size_t i = 0; i < s.size(); i++) {
    char c = s[i];
    bool ok = (c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z');
    if (!ok) return false;
  }
  return true;
}

// The JSON the station publishes. Returns "" if any field is unsafe.
inline std::string eventJson(HmacFn hmac, const uint8_t* key, size_t keyLen, const std::string& stationId,
                             uint64_t seq, const std::string& type, const std::string& uid, const std::string& flag) {
  if (!isSafeToken(type) || !isSafeToken(uid) || !isSafeToken(flag)) return "";
  std::string sig = signHex(hmac, key, keyLen, canonicalEvent(stationId, seq, type, uid, flag));
  char seqBuf[24];
  snprintf(seqBuf, sizeof seqBuf, "%llu", static_cast<unsigned long long>(seq));
  return std::string("{\"v\":1,\"seq\":") + seqBuf + ",\"type\":\"" + type + "\",\"uid\":\"" + uid +
         "\",\"flag\":\"" + flag + "\",\"sig\":\"" + sig + "\"}";
}

struct Reply {
  uint64_t seq;
  bool ok;
  std::string led, l1, l2, sig;
};

// A reply is trusted only if it is signed with this station's key AND answers
// the message we are actually waiting for (so an old reply can't be replayed).
inline bool verifyReply(HmacFn hmac, const uint8_t* key, size_t keyLen, const std::string& stationId,
                        uint64_t expectedSeq, const Reply& r) {
  if (r.seq != expectedSeq) return false;
  std::string expected = signHex(hmac, key, keyLen, canonicalReply(stationId, r.seq, r.ok, r.led, r.l1, r.l2));
  return constantTimeEquals(expected, r.sig);
}

// ------------------------------------------------------------ small state

// Message sequence = wall-clock milliseconds, but never repeats or goes back,
// even if NTP adjusts the clock. The server rejects anything not strictly higher.
class SeqClock {
 public:
  uint64_t next(uint64_t nowMs) {
    if (nowMs <= last_) nowMs = last_ + 1;
    last_ = nowMs;
    return nowMs;
  }

 private:
  uint64_t last_ = 0;
};

// A card held on the reader is read many times a second; count it once.
class TapDebouncer {
 public:
  explicit TapDebouncer(uint32_t windowMs = 1500) : windowMs_(windowMs) {}
  bool accept(const std::string& uid, uint32_t nowMs) {
    if (uid == last_ && (nowMs - lastMs_) < windowMs_) {
      lastMs_ = nowMs;  // still held: extend the window
      return false;
    }
    last_ = uid;
    lastMs_ = nowMs;
    return true;
  }

 private:
  uint32_t windowMs_;
  std::string last_;
  uint32_t lastMs_ = 0;
};

// "Report a problem" button: arms the next tool tap for a short time.
class ProblemFlag {
 public:
  void arm(uint32_t nowMs, uint32_t forMs = 15000) {
    armed_ = true;
    until_ = nowMs + forMs;
  }
  bool active(uint32_t nowMs) {
    if (armed_ && static_cast<int32_t>(nowMs - until_) >= 0) armed_ = false;
    return armed_;
  }
  void clear() { armed_ = false; }

 private:
  bool armed_ = false;
  uint32_t until_ = 0;
};

}  // namespace tt
