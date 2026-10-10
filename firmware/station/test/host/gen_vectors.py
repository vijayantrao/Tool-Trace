"""Turns ../vectors.json into a C++ header, so the C++ tests check exactly the
same values as the API's TypeScript tests."""
import json, pathlib, sys

here = pathlib.Path(__file__).parent
v = json.loads((here.parent / 'vectors.json').read_text())
q = lambda s: json.dumps(s)  # JSON string literal == valid C++ string literal for these ASCII values
out = ['// Generated from test/vectors.json by gen_vectors.py. Do not edit.', '#pragma once', '#include <cstdint>', '',
       'struct EventVector { uint64_t seq; const char* type; const char* uid; const char* flag; const char* canonical; const char* sig; };',
       'struct ReplyVector { uint64_t seq; bool ok; const char* led; const char* l1; const char* l2; const char* canonical; const char* sig; };',
       f'static const char* V_STATION_ID = {q(v["stationId"])};',
       f'static const char* V_STATION_KEY_HEX = {q(v["stationKeyHex"])};',
       'static const EventVector V_EVENTS[] = {']
for m in v['messages']:
    out.append(f'  {{{m["seq"]}ULL, {q(m["type"])}, {q(m["uid"])}, {q(m["flag"])}, {q(m["canonical"])}, {q(m["sig"])}}},')
out.append('};')
out.append('static const ReplyVector V_REPLIES[] = {')
for r in v['replies']:
    out.append(f'  {{{r["seq"]}ULL, {"true" if r["ok"] else "false"}, {q(r["led"])}, {q(r["l1"])}, {q(r["l2"])}, {q(r["canonical"])}, {q(r["sig"])}}},')
out.append('};')
(pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else here / 'vectors.h').write_text('\n'.join(out) + '\n')
