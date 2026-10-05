# -*- coding: utf-8 -*-
"""Encode le registre et le réseau en data.js compact."""
import json, unicodedata
from airports import A, COUNTRIES, CITY_ALIASES

F = json.load(open("flights.json"))
AIRLINES = json.load(open("airlines.json"))

iata_list = sorted(A.keys())
idx = {k: i for i, k in enumerate(iata_list)}

tz_list = sorted({v[5] for v in A.values()})
tz_idx = {t: i for i, t in enumerate(tz_list)}

ac_list = sorted({f[4] for f in F.values()})
ac_idx = {t: i for i, t in enumerate(ac_list)}

term_list = sorted({f[5] for f in F.values()} | {f[6] for f in F.values()})
term_idx = {t: i for i, t in enumerate(term_list)}

def deacc(s):
    return "".join(c for c in unicodedata.normalize("NFD", s)
                   if unicodedata.category(c) != "Mn").lower()

# --- aéroports : IATA|ville|nom|CC|lat|lon|tzIdx|rank
ap_rows = []
for k in iata_list:
    city, name, cc, la, lo, tz, rk = A[k]
    ap_rows.append(f"{k}|{city}|{name}|{cc}|{la}|{lo}|{tz_idx[tz]}|{rk}")
APS = "\n".join(ap_rows)

# --- pays : CC|nom|alias1;alias2
cty_rows = []
for cc, (name, aliases) in sorted(COUNTRIES.items()):
    al = sorted({deacc(x) for x in aliases} | {deacc(name)})
    cty_rows.append(f"{cc}|{name}|{';'.join(al)}")
CTY = "\n".join(cty_rows)

# --- alias de villes : saisie|NomVille
city_names = {v[0] for v in A.values()}
CAL = "\n".join(f"{deacc(k)}|{v}" for k, v in sorted(CITY_ALIASES.items())
                if v in city_names and deacc(k) != deacc(v))

# --- compagnies : code|nom
AIR = "\n".join(f"{c}|{n}" for c, n in sorted(AIRLINES.items()))

# --- vols : code|depIdx|arrIdx|depMin|dur|acIdx|tdIdx|taIdx
fl_rows = []
for num, f in sorted(F.items()):
    o, d_, dep, dur, ac, td, ta = f
    h, m = dep.split(":")
    fl_rows.append(f"{num}|{idx[o]}|{idx[d_]}|{int(h)*60+int(m)}|{dur}|{ac_idx[ac]}|{term_idx[td]}|{term_idx[ta]}")
FLS = "\n".join(fl_rows)

def js_str(s):
    return json.dumps(s, ensure_ascii=False)

out = f"""/* SkySearch — base de données embarquée.
   Généré automatiquement. Ne pas éditer à la main : régénérer via les scripts.
   {len(iata_list)} aéroports · {len(COUNTRIES)} pays · {len(AIRLINES)} compagnies · {len(F)} vols

   Les heures d'arrivée ne sont pas stockées. Chaque vol porte son heure de
   départ locale et sa durée bloc ; l'arrivée, le décalage de jour et le
   fuseau sont calculés à l'exécution. Une durée ne peut donc pas contredire
   la géographie. */
window.SKYDATA = {{
  tz: {json.dumps(tz_list, ensure_ascii=False)},
  ac: {json.dumps(ac_list, ensure_ascii=False)},
  term: {json.dumps(term_list, ensure_ascii=False)},
  aps: {js_str(APS)},
  cty: {js_str(CTY)},
  cal: {js_str(CAL)},
  air: {js_str(AIR)},
  fls: {js_str(FLS)}
}};
"""
open("data.js", "w", encoding="utf-8").write(out)

kb = len(out.encode()) / 1024
print(f"data.js : {kb:.0f} Ko")
print(f"  {len(iata_list)} aéroports · {len(COUNTRIES)} pays · {len(F)} vols")
print(f"  {len(tz_list)} fuseaux · {len(ac_list)} types d'appareil · {len(term_list)} terminaux")
