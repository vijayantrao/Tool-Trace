// Host unit tests for the station core. Build and run: make -C test/host
#include <openssl/hmac.h>

#include <cstdio>
#include <cstring>
#include <string>

#include "../../src/station_core.h"
#include "vectors.h"

static int failures = 0, checks = 0;
#define CHECK(cond)                                                    \
  do {                                                                 \
    checks++;                                                          \
    if (!(cond)) {                                                     \
      failures++;                                                      \
      std::printf("FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond);      \
    }                                                                  \
  } while (0)

static void opensslHmac(const uint8_t* key, size_t keyLen, const uint8_t* msg, size_t len, uint8_t out[32]) {
  unsigned int outLen = 32;
  HMAC(EVP_sha256(), key, static_cast<int>(keyLen), msg, len, out, &outLen);
}

int main() {
  uint8_t key[32];
  CHECK(tt::fromHex(V_STATION_KEY_HEX, key, sizeof key));
  const std::string station = V_STATION_ID;

  // --- Hex helpers
  {
    uint8_t b[4];
    CHECK(tt::fromHex("c0FFee99", b, 4));
    CHECK(tt::uidHex(b, 4) == "C0FFEE99");
    CHECK(!tt::fromHex("c0ffee9", b, 4));    // too short
    CHECK(!tt::fromHex("c0ffee9900", b, 4)); // too long
    CHECK(!tt::fromHex("zzffee99", b, 4));   // not hex
  }

  // --- Events: canonical form and signatures match the TypeScript API
  for (const auto& v : V_EVENTS) {
    std::string c = tt::canonicalEvent(station, v.seq, v.type, v.uid, v.flag);
    CHECK(c == v.canonical);
    CHECK(tt::signHex(opensslHmac, key, sizeof key, c) == v.sig);
    std::string json = tt::eventJson(opensslHmac, key, sizeof key, station, v.seq, v.type, v.uid, v.flag);
    CHECK(json.find(std::string("\"sig\":\"") + v.sig + "\"") != std::string::npos);
    CHECK(json.find("\"v\":1,") != std::string::npos);
  }
  // Fields that would need escaping are refused outright.
  CHECK(tt::eventJson(opensslHmac, key, sizeof key, station, 1, "tap", "AB\"CD", "ok").empty());
  CHECK(tt::eventJson(opensslHmac, key, sizeof key, station, 1, "tap", "AB|CD", "ok").empty());

  // --- Replies: genuine ones verify; anything altered, replayed or foreign does not
  for (const auto& v : V_REPLIES) {
    tt::Reply r{v.seq, v.ok, v.led, v.l1, v.l2, v.sig};
    CHECK(tt::canonicalReply(station, r.seq, r.ok, r.led, r.l1, r.l2) == v.canonical);
    CHECK(tt::verifyReply(opensslHmac, key, sizeof key, station, v.seq, r));

    tt::Reply tampered = r;
    tampered.l1 = "Checked out";
    CHECK(!tt::verifyReply(opensslHmac, key, sizeof key, station, v.seq, tampered));

    tt::Reply flipped = r;
    flipped.ok = !r.ok;
    CHECK(!tt::verifyReply(opensslHmac, key, sizeof key, station, v.seq, flipped));

    CHECK(!tt::verifyReply(opensslHmac, key, sizeof key, station, v.seq + 1, r));  // answer to another message

    uint8_t otherKey[32];
    std::memcpy(otherKey, key, 32);
    otherKey[0] ^= 1;
    CHECK(!tt::verifyReply(opensslHmac, otherKey, sizeof otherKey, station, v.seq, r));
  }

  // --- Sequence never repeats or goes backwards
  {
    tt::SeqClock clock;
    CHECK(clock.next(1000) == 1000);
    CHECK(clock.next(1000) == 1001);  // same millisecond
    CHECK(clock.next(900) == 1002);   // clock stepped back (NTP correction)
    CHECK(clock.next(5000) == 5000);
  }

  // --- A card held on the reader counts once
  {
    tt::TapDebouncer d(1500);
    CHECK(d.accept("AA", 0));
    CHECK(!d.accept("AA", 100));
    CHECK(!d.accept("AA", 1400));
    CHECK(!d.accept("AA", 2800));  // still held: window keeps extending
    CHECK(d.accept("BB", 2900));   // a different card is accepted at once
    CHECK(d.accept("AA", 3000));
    CHECK(d.accept("AA", 4600));   // lifted and tapped again
  }

  // --- Problem button arms the next tap only for a while
  {
    tt::ProblemFlag p;
    CHECK(!p.active(0));
    p.arm(1000, 15000);
    CHECK(p.active(1000));
    CHECK(p.active(15999));
    CHECK(!p.active(16000));
    p.arm(20000);
    p.clear();
    CHECK(!p.active(20001));
    p.arm(0xFFFFFF00u, 1000);  // survives millis() wrapping around
    CHECK(p.active(0xFFFFFFF0u));
    CHECK(p.active(0x00000100u));
    CHECK(!p.active(0x00000400u));
  }

  // --- Constant-time compare
  CHECK(tt::constantTimeEquals("abc", "abc"));
  CHECK(!tt::constantTimeEquals("abc", "abd"));
  CHECK(!tt::constantTimeEquals("abc", "abcd"));

  std::printf("%d checks, %d failed\n", checks, failures);
  return failures == 0 ? 0 : 1;
}
