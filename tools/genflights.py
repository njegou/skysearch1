# -*- coding: utf-8 -*-
"""Génère un réseau de vols plausible à partir du registre d'aéroports.

Principe : aucune heure d'arrivée n'est saisie. On stocke le départ local et
la durée bloc, calculée depuis la distance orthodromique. L'arrivée, le
décalage de jour et le fuseau sont dérivés à l'exécution. Impossible, par
construction, d'avoir une durée incohérente avec la géographie.
"""
import math, random, json
from airports import A, COUNTRIES

random.seed(20261005)

# ---------------------------------------------------------------- régions
REGION = {}
for cc in ["FR","ES","IT","DE","GB","GR","PT","NL","BE","CH","AT","LU","IE","DK","SE",
           "NO","FI","IS","EE","LV","LT","PL","CZ","HU","RO","BG","HR","RS","SK","SI",
           "AL","MK","MT","CY","TR","RU"]:
    REGION[cc] = "EU"
for cc in ["US","CA","MX","CU","DO","PA","CR"]:
    REGION[cc] = "NA"
for cc in ["BR","AR","CL","PE","CO","EC","UY"]:
    REGION[cc] = "SA"
for cc in ["JP","KR","CN","HK","MO","TW","SG","TH","MY","ID","PH","VN","KH","MM","LA",
           "IN","PK","BD","LK","NP","MV"]:
    REGION[cc] = "AS"
for cc in ["AE","QA","SA","KW","BH","OM","JO","IL","LB","IR"]:
    REGION[cc] = "ME"
for cc in ["EG","MA","TN","DZ","ZA","KE","ET","NG","GH","SN","CI","TZ","UG","MU","SC","MG"]:
    REGION[cc] = "AF"
for cc in ["AU","NZ","FJ"]:
    REGION[cc] = "OC"

def region(iata):
    return REGION.get(A[iata][2], "XX")

def country(iata):
    return A[iata][2]

def rank(iata):
    return A[iata][6]

# ---------------------------------------------------------------- géométrie
def dist(a, b):
    R = 6371.0
    la1, lo1 = math.radians(A[a][3]), math.radians(A[a][4])
    la2, lo2 = math.radians(A[b][3]), math.radians(A[b][4])
    h = math.sin((la2-la1)/2)**2 + math.cos(la1)*math.cos(la2)*math.sin((lo2-lo1)/2)**2
    return 2*R*math.asin(math.sqrt(h))

def block_time(d):
    """Durée bloc en minutes, calibrée sur des vols réels (±15 min)."""
    cruise = 780 + min(100, d/150.0)
    return int(round(35 + (d/cruise)*60*1.12))

# ---------------------------------------------------------------- compagnies
FLAG = {
"FR":[("AF","Air France",.55),("U2","easyJet",.2),("TO","Transavia",.15),("FR","Ryanair",.1)],
"ES":[("IB","Iberia",.4),("VY","Vueling",.35),("FR","Ryanair",.15),("UX","Air Europa",.1)],
"IT":[("AZ","ITA Airways",.45),("FR","Ryanair",.35),("U2","easyJet",.2)],
"DE":[("LH","Lufthansa",.6),("EW","Eurowings",.25),("FR","Ryanair",.15)],
"GB":[("BA","British Airways",.45),("U2","easyJet",.3),("FR","Ryanair",.15),("VS","Virgin Atlantic",.1)],
"GR":[("A3","Aegean Airlines",.6),("OA","Olympic Air",.25),("FR","Ryanair",.15)],
"PT":[("TP","TAP Air Portugal",.7),("FR","Ryanair",.3)],
"NL":[("KL","KLM",.75),("HV","Transavia",.25)],
"BE":[("SN","Brussels Airlines",.7),("FR","Ryanair",.3)],
"CH":[("LX","Swiss",.7),("U2","easyJet",.3)],
"AT":[("OS","Austrian Airlines",.8),("FR","Ryanair",.2)],
"LU":[("LG","Luxair",1.0)],
"IE":[("EI","Aer Lingus",.5),("FR","Ryanair",.5)],
"DK":[("SK","SAS",.7),("DY","Norwegian",.3)],
"SE":[("SK","SAS",.6),("DY","Norwegian",.4)],
"NO":[("DY","Norwegian",.55),("SK","SAS",.45)],
"FI":[("AY","Finnair",1.0)],
"IS":[("FI","Icelandair",1.0)],
"EE":[("OV","Nordica",1.0)],"LV":[("BT","airBaltic",1.0)],"LT":[("BT","airBaltic",1.0)],
"PL":[("LO","LOT Polish Airlines",.7),("FR","Ryanair",.3)],
"CZ":[("OK","Czech Airlines",.6),("FR","Ryanair",.4)],
"HU":[("W6","Wizz Air",.7),("FR","Ryanair",.3)],
"RO":[("RO","TAROM",.5),("W6","Wizz Air",.5)],
"BG":[("FB","Bulgaria Air",.6),("W6","Wizz Air",.4)],
"HR":[("OU","Croatia Airlines",1.0)],
"RS":[("JU","Air Serbia",1.0)],"SK":[("W6","Wizz Air",1.0)],"SI":[("JP","Adria",1.0)],
"AL":[("W6","Wizz Air",1.0)],"MK":[("W6","Wizz Air",1.0)],
"MT":[("KM","Air Malta",1.0)],"CY":[("CY","Cyprus Airways",1.0)],
"TR":[("TK","Turkish Airlines",.7),("PC","Pegasus",.3)],
"RU":[("SU","Aeroflot",1.0)],
"US":[("AA","American Airlines",.3),("DL","Delta",.3),("UA","United",.3),("B6","JetBlue",.1)],
"CA":[("AC","Air Canada",.8),("WS","WestJet",.2)],
"MX":[("AM","Aeroméxico",.7),("Y4","Volaris",.3)],
"CU":[("CU","Cubana",1.0)],"DO":[("DM","Arajet",1.0)],
"PA":[("CM","Copa Airlines",1.0)],"CR":[("CM","Copa Airlines",1.0)],
"BR":[("LA","LATAM",.5),("G3","GOL",.35),("AD","Azul",.15)],
"AR":[("AR","Aerolíneas Argentinas",1.0)],
"CL":[("LA","LATAM",1.0)],"PE":[("LA","LATAM",1.0)],
"CO":[("AV","Avianca",1.0)],"EC":[("AV","Avianca",1.0)],"UY":[("AR","Aerolíneas Argentinas",1.0)],
"JP":[("NH","ANA",.45),("JL","Japan Airlines",.45),("MM","Peach",.1)],
"KR":[("KE","Korean Air",.55),("OZ","Asiana",.45)],
"CN":[("CA","Air China",.3),("MU","China Eastern",.3),("CZ","China Southern",.3),("HU","Hainan",.1)],
"HK":[("CX","Cathay Pacific",1.0)],"MO":[("NX","Air Macau",1.0)],
"TW":[("BR","EVA Air",.55),("CI","China Airlines",.45)],
"SG":[("SQ","Singapore Airlines",.75),("TR","Scoot",.25)],
"TH":[("TG","Thai Airways",.6),("FD","Thai AirAsia",.4)],
"MY":[("MH","Malaysia Airlines",.5),("AK","AirAsia",.5)],
"ID":[("GA","Garuda Indonesia",.6),("QG","Citilink",.4)],
"PH":[("PR","Philippine Airlines",.6),("5J","Cebu Pacific",.4)],
"VN":[("VN","Vietnam Airlines",.7),("VJ","VietJet",.3)],
"KH":[("K6","Cambodia Angkor Air",1.0)],"MM":[("UB","Myanmar National",1.0)],
"LA":[("QV","Lao Airlines",1.0)],
"IN":[("6E","IndiGo",.55),("AI","Air India",.45)],
"PK":[("PK","Pakistan International",1.0)],"BD":[("BG","Biman Bangladesh",1.0)],
"LK":[("UL","SriLankan Airlines",1.0)],"NP":[("RA","Nepal Airlines",1.0)],
"MV":[("Q2","Maldivian",1.0)],
"AE":[("EK","Emirates",.6),("EY","Etihad Airways",.3),("FZ","flydubai",.1)],
"QA":[("QR","Qatar Airways",1.0)],
"SA":[("SV","Saudia",.8),("XY","flynas",.2)],
"KW":[("KU","Kuwait Airways",1.0)],"BH":[("GF","Gulf Air",1.0)],"OM":[("WY","Oman Air",1.0)],
"JO":[("RJ","Royal Jordanian",1.0)],"IL":[("LY","El Al",1.0)],"LB":[("ME","Middle East Airlines",1.0)],
"IR":[("IR","Iran Air",1.0)],
"EG":[("MS","EgyptAir",1.0)],
"MA":[("AT","Royal Air Maroc",.8),("3O","Air Arabia Maroc",.2)],
"TN":[("TU","Tunisair",1.0)],"DZ":[("AH","Air Algérie",1.0)],
"ZA":[("SA","South African Airways",.6),("FA","FlySafair",.4)],
"KE":[("KQ","Kenya Airways",1.0)],"ET":[("ET","Ethiopian Airlines",1.0)],
"NG":[("W3","Arik Air",1.0)],"GH":[("ET","Ethiopian Airlines",1.0)],
"SN":[("HC","Air Sénégal",1.0)],"CI":[("HF","Air Côte d'Ivoire",1.0)],
"TZ":[("TC","Air Tanzania",1.0)],"UG":[("UR","Uganda Airlines",1.0)],
"MU":[("MK","Air Mauritius",1.0)],"SC":[("HM","Air Seychelles",1.0)],
"MG":[("MD","Madagascar Airlines",1.0)],
"AU":[("QF","Qantas",.55),("JQ","Jetstar",.25),("VA","Virgin Australia",.2)],
"NZ":[("NZ","Air New Zealand",.8),("JQ","Jetstar",.2)],
"FJ":[("FJ","Fiji Airways",1.0)],
}

def pick_airline(origin, dest, long_haul):
    """Compagnie du pays de départ ; sur long-courrier on écarte les low-cost."""
    opts = FLAG.get(country(origin)) or FLAG.get(country(dest)) or [("XX","Compagnie",1.0)]
    if long_haul:
        full = [o for o in opts if o[0] not in ("FR","U2","W6","PC","TO","HV","FD","AK",
                                                "QG","5J","VJ","Y4","G3","MM","TR","DY","EW","3O","XY","FA","JQ","B6")]
        if full:
            opts = full
    codes = [o[0] for o in opts]
    weights = [o[2] for o in opts]
    return random.choices(codes, weights=weights)[0]

# ---------------------------------------------------------------- horaires
SHORT_SLOTS = [6*60+40, 8*60+15, 10*60+30, 12*60+45, 14*60+50, 17*60+10, 19*60+25, 21*60+5]
LONG_SLOTS  = [9*60+40, 11*60+25, 13*60+15, 15*60+50, 21*60+30, 23*60+40, 1*60+35, 7*60+55]

def pick_times(n, long_haul, salt):
    pool = LONG_SLOTS if long_haul else SHORT_SLOTS
    rnd = random.Random(salt)
    base = rnd.sample(pool, min(n, len(pool)))
    out = []
    for b in base:
        out.append((b + rnd.randint(-12, 12)) % 1440)
    return sorted(out)

TERMINALS = ["1","2","2A","2C","2E","2F","3","4","5","A","B","C","D","E","M","N","S","T1","T2","T3"]
AIRCRAFT_SHORT = ["A319","A320","A320neo","A321neo","B737-800","B737 MAX 8","E190","E195","ATR 72","CRJ-900"]
AIRCRAFT_MED   = ["A321neo","A321LR","B737 MAX 8","A320neo","B757-200"]
AIRCRAFT_LONG  = ["A330-300","A330-900neo","A350-900","A350-1000","B777-300ER","B787-9","B787-10","A380","B777-200ER","B747-8"]

def pick_aircraft(d, rnd):
    if d < 1500: return rnd.choice(AIRCRAFT_SHORT)
    if d < 4000: return rnd.choice(AIRCRAFT_MED)
    return rnd.choice(AIRCRAFT_LONG)

# ---------------------------------------------------------------- routes
routes = set()

def add(a, b):
    if a == b: return
    d = dist(a, b)
    if d < 180: return                      # trop court pour un vol commercial
    routes.add((a, b)); routes.add((b, a))  # toujours les deux sens

by_country = {}
for k, v in A.items():
    by_country.setdefault(v[2], []).append(k)

# 1. domestique : chaque hub du pays vers les autres aéroports du pays
for cc, aps in by_country.items():
    hubs = sorted([x for x in aps if rank(x) == 1]) or sorted([x for x in aps if rank(x) == 2]) or aps[:1]
    for h in hubs:
        for other in aps:
            if other != h:
                add(h, other)
    majors = sorted([x for x in aps if rank(x) <= 2])
    for i, x in enumerate(majors):
        for y in majors[i+1:]:
            if random.random() < .5:
                add(x, y)

# 2. intra-région : aéroports majeurs reliés entre eux sous 4500 km
majors_by_region = {}
for k, v in A.items():
    if rank(k) <= 2:
        majors_by_region.setdefault(region(k), []).append(k)

for reg, aps in majors_by_region.items():
    for i, x in enumerate(aps):
        for y in aps[i+1:]:
            if country(x) == country(y): continue
            d = dist(x, y)
            if d <= 4000:
                if rank(x) == 1 and rank(y) == 1: add(x, y)
                elif d <= 2000 and random.random() < .55: add(x, y)

# 3. hubs vers aéroports de rang 3 de la même région (desserte régionale)
for reg, aps in majors_by_region.items():
    hubs = [x for x in aps if rank(x) == 1]
    smalls = [k for k in A if region(k) == reg and rank(k) == 3]
    for h in hubs:
        for s in smalls:
            if country(h) == country(s): continue
            if dist(h, s) <= 3000 and random.random() < .32:
                add(h, s)

# 4. intercontinental : hubs rang 1 entre régions
hubs1 = [k for k in A if rank(k) == 1]
for i, x in enumerate(hubs1):
    for y in hubs1[i+1:]:
        if region(x) == region(y): continue
        d = dist(x, y)
        if d > 16000: continue                      # au-delà du sans-escale réaliste
        if d <= 12000 or random.random() < .75: add(x, y)

# 4b. maillage garanti : le hub principal de chaque pays vers celui des autres.
# Sans ce passage, des paires évidentes (Pays-Bas → Indonésie) tombaient au hasard.
primary = {}
for cc_, aps in by_country.items():
    ranked = sorted(aps, key=lambda x: (rank(x), -len([1 for z in aps])))
    primary[cc_] = ranked[0]
pc = sorted(primary.items())
for i, (c1, h1) in enumerate(pc):
    for c2, h2 in pc[i+1:]:
        d = dist(h1, h2)
        if d > 13000: continue
        if rank(h1) == 1 or rank(h2) == 1:
            add(h1, h2)
        elif d <= 3500 and random.random() < .5:
            add(h1, h2)

# 5. quelques rang 2 intercontinentaux depuis les très grands hubs
BIG = ["CDG","LHR","AMS","FRA","IST","DXB","DOH","JFK","LAX","SIN","HKG","ICN","NRT","MAD","ATH"]
for h in BIG:
    for k in A:
        if region(k) == region(h) or rank(k) != 2: continue
        if dist(h, k) <= 11000 and random.random() < .14: add(h, k)

# 6. routes loisirs explicites (France et Europe vers bassins touristiques)
LEISURE_ORIGINS = ["CDG","ORY","LYS","MRS","NCE","TLS","BOD","NTE","LHR","LGW","MAN","BRU",
                   "AMS","FRA","MUC","BER","DUS","MXP","FCO","MAD","BCN","GVA","ZRH","VIE","CRL"]
LEISURE_DESTS = ["HER","RHO","JTR","JMK","CFU","KGS","ZTH","CHQ","SKG","ATH","AGP","PMI","IBZ",
                 "ALC","FAO","TFS","LPA","ACE","FUE","DJE","TUN","RAK","AGA","TNG","FEZ","HRG",
                 "SSH","AYT","BJV","ADB","CTA","PMO","NAP","CAG","OLB" ,"SPU","DBV","MLA","LCA",
                 "PFO","FNC","CMN","CUN","PUJ","MLE","DPS","HKT"]
for o in LEISURE_ORIGINS:
    for d_ in LEISURE_DESTS:
        if d_ not in A or o not in A: continue
        if country(o) == country(d_): continue
        if dist(o, d_) <= 7000 and random.random() < .3:
            add(o, d_)

# 7. Filet de sécurité : aucun aéroport ne doit rester sans vol
linked = set()
for (a, b) in routes:
    linked.add(a); linked.add(b)
for k in A:
    if k in linked: continue
    cands = sorted([h for h in A if h != k and rank(h) <= 2],
                   key=lambda h: (0 if country(h) == country(k) else 1, dist(k, h)))
    for h in cands[:3]:
        if dist(k, h) <= 12000:
            add(k, h)

print("routes dirigées :", len(routes))

# ---------------------------------------------------------------- vols
flights = {}
used_numbers = set()

def make_number(code, rnd):
    for _ in range(400):
        n = rnd.randint(1, 1999) if rnd.random() < .5 else rnd.randint(2000, 9899)
        key = f"{code}{n}"
        if key not in used_numbers:
            used_numbers.add(key)
            return key
    n = 1
    while f"{code}{n}" in used_numbers:
        n += 1
    used_numbers.add(f"{code}{n}")
    return f"{code}{n}"

route_list = sorted(routes)
for idx, (o, d_) in enumerate(route_list):
    km = dist(o, d_)
    long_haul = km >= 4000
    rnd = random.Random(hash((o, d_)) & 0xFFFFFFFF)

    # fréquence : plus la route est courte et les aéroports importants, plus il y a de vols
    imp = (4 - rank(o)) + (4 - rank(d_))          # 2..6
    # Une fréquence par route suffit ; on n'en met deux que sur les liaisons
    # entre grands hubs, là où un voyageur attend vraiment un choix d'horaire.
    freq = 2 if (imp >= 6 and km < 2500) else 1

    times = pick_times(freq, long_haul, hash((o, d_, "t")) & 0xFFFFFFFF)
    for t in times:
        code = pick_airline(o, d_, long_haul)
        num = make_number(code, rnd)
        flights[num] = [
            o, d_,
            f"{t//60:02d}:{t%60:02d}",
            block_time(km),
            pick_aircraft(km, rnd),
            rnd.choice(TERMINALS) if rank(o) <= 2 else "",
            rnd.choice(TERMINALS) if rank(d_) <= 2 else "",
        ]

print("vols :", len(flights))

# ---------------------------------------------------------------- validations
errs = 0
for num, f in flights.items():
    o, d_, dep, dur = f[0], f[1], f[2], f[3]
    km = dist(o, d_)
    floor = 25 + km/900*60
    ceil_ = 70 + km/620*60
    if not (floor*0.9 <= dur <= ceil_*1.2):
        errs += 1
        if errs < 6: print("  durée suspecte", num, o, d_, int(km), "km", dur, "min")
    h, m = dep.split(":")
    assert 0 <= int(h) <= 23 and 0 <= int(m) <= 59, num
print("durées hors bornes géographiques :", errs)

undirected = set()
for f in flights.values():
    undirected.add((f[0], f[1]))
bidir = sum(1 for (a, b) in undirected if (b, a) in undirected)
print("routes couvertes :", len(undirected), "| bidirectionnelles :", bidir,
      f"({round(bidir/len(undirected)*100)}%)")

served = set()
for f in flights.values():
    served.add(f[0]); served.add(f[1])
print("aéroports desservis :", len(served), "/", len(A))
orphans = [k for k in A if k not in served]
print("aéroports sans aucun vol :", orphans or "aucun")

cc_served = {}
for f in flights.values():
    cc_served[country(f[0])] = cc_served.get(country(f[0]), 0) + 1
print("pays avec au moins un départ :", len(cc_served), "/", len(by_country))

airlines = {}
for opts in FLAG.values():
    for code, name, _w in opts:
        airlines[code] = name
used = {num[:2] if not num[:2].isdigit() or not num[0].isdigit() else num[:2] for num in flights}
used = set()
for num in flights:
    for code in airlines:
        if num.startswith(code) and num[len(code):].isdigit():
            used.add(code); break
missing = used - set(airlines)
assert not missing, missing
print("compagnies utilisées :", len(used), "/", len(airlines))
json.dump({k: v for k, v in airlines.items() if k in used},
          open("airlines.json", "w"), ensure_ascii=False)
json.dump(flights, open("flights.json", "w"), ensure_ascii=False)
print("écrit flights.json")
