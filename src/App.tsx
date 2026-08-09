import { useEffect, useMemo, useState } from "react";
import { BrowserProvider, Contract, keccak256, toUtf8Bytes, JsonRpcSigner } from "ethers";
import { cofhejs, Encryptable, FheTypes } from "cofhejs/web";

const FHENIX_NAMES_ADDRESS = import.meta.env.VITE_FHENIX_NAMES_ADDRESS as string;
const ARB_SEPOLIA = 421614;

const IN128 = "(uint256 ctHash,uint8 securityZone,uint8 utype,bytes signature)";

const ABI = [
  `function claim(${IN128} encHi, ${IN128} encLo) returns (uint256)`,
  "function settle(uint256 claimId, string name)",
  "function claimReady(uint256 claimId) view returns (bool)",
  "function resolve(string name) view returns (address)",
  "function reverse(address who) view returns (string)",
  "function isAvailable(string name) view returns (bool)",
  "function recordOf(string name) view returns (address owner, uint64 registeredAt)",
  "function setPrimary(string name)",
  "function transfer(string name, address to)",
  `function setProfile(string name, bytes32 key, ${IN128} encValue)`,
  "function shareProfile(string name, bytes32 key, address viewer)",
  "function getProfile(string name, bytes32 key) view returns (uint256)",
  "function hashParts(string name) view returns (uint128 hi, uint128 lo)",
  "event Claimed(uint256 indexed claimId, address indexed claimant, uint64 at)",
  "event Registered(bytes32 indexed nameHash, string name, address indexed owner)",
];

type Step = "idle" | "encrypting" | "claiming" | "waiting" | "settling" | "done";

const PROFILE_FIELDS = [
  { label: "Telegram", key: "telegram" },
  { label: "E-posta", key: "email" },
  { label: "Not", key: "note" },
];

// en fazla 16 byte metni uint128'e cevirir
function textToUint(s: string): bigint {
  const b = toUtf8Bytes(s);
  if (b.length > 16) throw new Error("En fazla 16 karakter");
  if (b.length === 0) return 0n;
  let hex = "0x";
  for (const x of b) hex += x.toString(16).padStart(2, "0");
  return BigInt(hex);
}

function uintToText(v: bigint): string {
  if (v === 0n) return "";
  let hex = v.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  const bytes = hex.match(/.{2}/g) || [];
  try {
    return new TextDecoder().decode(Uint8Array.from(bytes.map((h) => parseInt(h, 16))));
  } catch {
    return "0x" + hex;
  }
}

const MASK128 = (1n << 128n) - 1n;

export default function App() {
  const [signer, setSigner] = useState<JsonRpcSigner | null>(null);
  const [account, setAccount] = useState("");
  const [ready, setReady] = useState(false);
  const [myName, setMyName] = useState("");

  const [tab, setTab] = useState<"register" | "lookup" | "profile">("register");
  const [log, setLog] = useState<string[]>([]);

  const say = (m: string) =>
    setLog((l) => [`${new Date().toLocaleTimeString()}  ${m}`, ...l].slice(0, 40));

  const contract = useMemo(
    () => (signer ? new Contract(FHENIX_NAMES_ADDRESS, ABI, signer) : null),
    [signer]
  );

  // ------------------------------------------------------------ baglanti

  async function connect() {
    const eth = (window as any).ethereum;
    if (!eth) return say("Cuzdan bulunamadi");

    const provider = new BrowserProvider(eth);
    await provider.send("eth_requestAccounts", []);

    const net = await provider.getNetwork();
    if (Number(net.chainId) !== ARB_SEPOLIA) {
      try {
        await eth.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: "0x66eee" }],
        });
      } catch {
        return say("Arbitrum Sepolia'ya gec");
      }
    }

    const s = await provider.getSigner();
    setSigner(s);
    setAccount(await s.getAddress());
    say("Cuzdan bagli");

    say("CoFHE baslatiliyor (ilk seferde 10-20 sn surebilir)");
    try {
      const r: any = await cofhejs.initializeWithEthers({
        ethersProvider: provider,
        ethersSigner: s,
        environment: "TESTNET",
      });
      if (r && r.success === false) throw new Error(r.error?.message || "init hatasi");
      setReady(true);
      say("CoFHE hazir");
    } catch (e: any) {
      say("CoFHE hatasi: " + e.message);
    }
  }

  useEffect(() => {
    if (!contract || !account) return;
    contract.reverse(account).then(setMyName).catch(() => {});
  }, [contract, account]);

  // -------------------------------------------------------- 1. kayit akisi

  const [name, setName] = useState("");
  const [step, setStep] = useState<Step>("idle");
  const [claimId, setClaimId] = useState<bigint | null>(null);
  const [decReady, setDecReady] = useState(false);

  async function checkAvailable() {
    if (!contract) return;
    try {
      const ok = await contract.isAvailable(name);
      say(ok ? `${name}.fhenix musait` : `${name}.fhenix alinmis veya gecersiz`);
    } catch (e: any) {
      say("Hata: " + e.message);
    }
  }

  async function doClaim() {
    if (!contract || !ready) return;
    try {
      setStep("encrypting");
      const h = BigInt(keccak256(toUtf8Bytes(name)));
      const hi = h >> 128n;
      const lo = h & MASK128;

      say("Isim hash'i ikiye bolunup sifreleniyor");
      const enc: any = await cofhejs.encrypt(() => {}, [
        Encryptable.uint128(hi),
        Encryptable.uint128(lo),
      ]);
      if (enc && enc.success === false) throw new Error(enc.error?.message);
      const [encHi, encLo] = enc.data;

      setStep("claiming");
      const tx = await contract.claim(encHi, encLo);
      say("claim gonderildi: " + tx.hash.slice(0, 18) + "...");
      const rc = await tx.wait();

      let id: bigint | null = null;
      for (const l of rc.logs) {
        try {
          const p = contract.interface.parseLog(l);
          if (p?.name === "Claimed") id = p.args[0];
        } catch {}
      }
      setClaimId(id);
      setDecReady(false);
      say(`Talep kaydedildi, id = ${id}. Sira zincirde kilitlendi.`);
      setStep("waiting");
    } catch (e: any) {
      setStep("idle");
      say("Hata: " + (e.shortMessage || e.message));
    }
  }

  // coprocessor cozunce butonu ac
  useEffect(() => {
    if (!contract || claimId === null || step !== "waiting") return;
    let alive = true;
    const t = setInterval(async () => {
      try {
        const ok = await contract.claimReady(claimId);
        if (ok && alive) {
          setDecReady(true);
          say("Coprocessor cozdu, sonuclandirabilirsin");
          clearInterval(t);
        }
      } catch {}
    }, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [contract, claimId, step]);

  async function doSettle() {
    if (!contract || claimId === null) return;
    try {
      setStep("settling");
      const tx = await contract.settle(claimId, name);
      say("settle gonderildi: " + tx.hash.slice(0, 18) + "...");
      await tx.wait();
      setStep("done");
      setMyName(name);
      say(`${name}.fhenix kaydedildi`);
    } catch (e: any) {
      setStep("waiting");
      const m = e.shortMessage || e.message || "";
      if (m.includes("DecryptPending")) say("Henuz cozulmedi, birkac saniye daha bekle");
      else if (m.includes("NameTaken")) say("Isim baskasi tarafindan alinmis");
      else if (m.includes("HashMismatch")) say("Isim talep ettiginden farkli");
      else say("Hata: " + m);
    }
  }

  // ---------------------------------------------------------- 2. cozumleme

  const [lookup, setLookup] = useState("");
  const [lookupResult, setLookupResult] = useState("");

  async function doLookup() {
    if (!contract) return;
    try {
      if (lookup.startsWith("0x")) {
        const n = await contract.reverse(lookup);
        setLookupResult(n ? `${n}.fhenix` : "kayit yok");
      } else {
        const a = await contract.resolve(lookup);
        setLookupResult(
          a === "0x0000000000000000000000000000000000000000" ? "kayit yok" : a
        );
      }
    } catch (e: any) {
      setLookupResult("hata: " + e.message);
    }
  }

  // ------------------------------------------------------- 3. sifreli profil

  const [fieldKey, setFieldKey] = useState("telegram");
  const [fieldValue, setFieldValue] = useState("");
  const [viewer, setViewer] = useState("");
  const [decrypted, setDecrypted] = useState<Record<string, string>>({});

  const keyHash = (k: string) => keccak256(toUtf8Bytes(k));

  async function saveField() {
    if (!contract || !ready || !myName) return;
    try {
      say("Alan sifreleniyor");
      const v = textToUint(fieldValue);
      const enc: any = await cofhejs.encrypt(() => {}, [Encryptable.uint128(v)]);
      if (enc && enc.success === false) throw new Error(enc.error?.message);

      const tx = await contract.setProfile(myName, keyHash(fieldKey), enc.data[0]);
      await tx.wait();
      say(`${fieldKey} sifreli olarak kaydedildi`);
    } catch (e: any) {
      say("Hata: " + (e.shortMessage || e.message));
    }
  }

  async function readField(k: string) {
    if (!contract || !ready || !myName) return;
    try {
      const handle = await contract.getProfile(myName, keyHash(k));
      if (handle === 0n) return say(`${k} bos`);

      const r: any = await cofhejs.unseal(handle, FheTypes.Uint128);
      if (r && r.success === false) throw new Error(r.error?.message);

      setDecrypted((d) => ({ ...d, [k]: uintToText(BigInt(r.data)) }));
      say(`${k} cozuldu, sadece senin tarayicinda`);
    } catch (e: any) {
      say("Hata: " + (e.shortMessage || e.message));
    }
  }

  async function share() {
    if (!contract || !myName) return;
    try {
      const tx = await contract.shareProfile(myName, keyHash(fieldKey), viewer);
      await tx.wait();
      say(`${viewer.slice(0, 10)}... artik ${fieldKey} alanini cozebilir`);
    } catch (e: any) {
      say("Hata: " + (e.shortMessage || e.message));
    }
  }

  // ------------------------------------------------------------------ ui

  return (
    <div style={S.page}>
      <div style={S.wrap}>
        <header style={S.header}>
          <div>
            <h1 style={S.h1}>
              Fhenix<span style={{ opacity: 0.4 }}>Names</span>
            </h1>
            <p style={S.sub}>Front-run edilemeyen isim kaydi · Fhenix CoFHE</p>
          </div>
          {account ? (
            <div style={S.badge}>
              <div style={{ fontWeight: 600 }}>{myName ? `${myName}.fhenix` : "isim yok"}</div>
              <div style={{ opacity: 0.5, fontSize: 12 }}>
                {account.slice(0, 6)}...{account.slice(-4)}
              </div>
            </div>
          ) : (
            <button style={S.btn} onClick={connect}>
              Cuzdani bagla
            </button>
          )}
        </header>

        <div style={S.tabs}>
          {(["register", "lookup", "profile"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              style={{ ...S.tab, ...(tab === t ? S.tabOn : {}) }}
            >
              {t === "register" ? "Kayit" : t === "lookup" ? "Cozumle" : "Sifreli profil"}
            </button>
          ))}
        </div>

        {tab === "register" && (
          <div style={S.card}>
            <div style={S.row}>
              <input
                style={S.input}
                placeholder="dnyelf"
                value={name}
                onChange={(e) => setName(e.target.value.toLowerCase())}
              />
              <span style={S.tld}>.fhenix</span>
              <button style={S.btnGhost} onClick={checkAvailable}>
                Sorgula
              </button>
            </div>

            <div style={S.steps}>
              <div style={{ ...S.stepBox, ...(claimId ? S.stepDone : {}) }}>
                <b>1 · Sifreli talep</b>
                <p style={S.stepText}>
                  keccak256(isim) ikiye bolunup tarayicinda sifrelenir. Mempool'daki bot
                  sadece ciphertext handle'i gorur, ismi cikaramaz. Sira bu islemde
                  zincirde kilitlenir.
                </p>
                <button
                  style={S.btn}
                  disabled={!ready || !name || step === "claiming" || step === "encrypting"}
                  onClick={doClaim}
                >
                  {step === "encrypting"
                    ? "Sifreleniyor..."
                    : step === "claiming"
                    ? "Gonderiliyor..."
                    : "Talep et"}
                </button>
              </div>

              <div style={{ ...S.stepBox, ...(claimId ? {} : { opacity: 0.35 }) }}>
                <b>2 · Sonuclandir</b>
                <p style={S.stepText}>
                  {claimId && !decReady
                    ? "Coprocessor cozuyor, bekle..."
                    : "Ismi acik gonderirsin, kontrat keccak ile dogrular. Sira 1. adimda belirlendigi icin ismin burada gorunmesi zararsiz."}
                </p>
                <button
                  style={S.btn}
                  disabled={claimId === null || !decReady || step === "settling"}
                  onClick={doSettle}
                >
                  {step === "settling" ? "Kaydediliyor..." : "Sonuclandir"}
                </button>
              </div>
            </div>

            <div style={S.note}>
              ENS burada commit-reveal kullanmak zorunda: 2 islem, 60 saniye bekleme,
              kullanicinin secret'i lokalde saklamasi gerekiyor. Burada secret yok.
            </div>
          </div>
        )}

        {tab === "lookup" && (
          <div style={S.card}>
            <div style={S.row}>
              <input
                style={S.input}
                placeholder="isim veya 0x adres"
                value={lookup}
                onChange={(e) => setLookup(e.target.value)}
              />
              <button style={S.btn} onClick={doLookup}>
                Cozumle
              </button>
            </div>
            {lookupResult && <div style={S.result}>{lookupResult}</div>}
          </div>
        )}

        {tab === "profile" && (
          <div style={S.card}>
            {!myName ? (
              <div style={S.note}>Once bir isim kaydet.</div>
            ) : (
              <>
                <div style={S.row}>
                  <select
                    style={S.input}
                    value={fieldKey}
                    onChange={(e) => setFieldKey(e.target.value)}
                  >
                    {PROFILE_FIELDS.map((f) => (
                      <option key={f.key} value={f.key}>
                        {f.label}
                      </option>
                    ))}
                  </select>
                  <input
                    style={S.input}
                    placeholder="deger (en fazla 16 karakter)"
                    value={fieldValue}
                    onChange={(e) => setFieldValue(e.target.value)}
                  />
                  <button style={S.btn} onClick={saveField}>
                    Sifrele ve kaydet
                  </button>
                </div>

                <div style={S.fields}>
                  {PROFILE_FIELDS.map((f) => (
                    <div key={f.key} style={S.field}>
                      <div>
                        <b>{f.label}</b>
                        <div
                          style={{ opacity: 0.6, fontSize: 13, fontFamily: "monospace" }}
                        >
                          {decrypted[f.key] ?? "••••••••  (zincirde sifreli)"}
                        </div>
                      </div>
                      <button style={S.btnGhost} onClick={() => readField(f.key)}>
                        Coz
                      </button>
                    </div>
                  ))}
                </div>

                <div style={{ ...S.row, marginTop: 20 }}>
                  <input
                    style={S.input}
                    placeholder="0x... izin verilecek adres"
                    value={viewer}
                    onChange={(e) => setViewer(e.target.value)}
                  />
                  <button style={S.btnGhost} onClick={share}>
                    Bu adrese ac
                  </button>
                </div>

                <div style={S.note}>
                  Alanlar zincirde ciphertext olarak duruyor. Varsayilan olarak sadece sen
                  cozebilirsin. Izin verdigin adres kendi tarayicisinda cozer, deger hicbir
                  zaman zincirde acik gorunmez.
                </div>
              </>
            )}
          </div>
        )}

        <div style={S.logBox}>
          {log.length === 0 ? (
            <div style={{ opacity: 0.35 }}>islem gunlugu</div>
          ) : (
            log.map((l, i) => (
              <div key={i} style={{ opacity: i === 0 ? 1 : 0.5 }}>
                {l}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100vh",
    background: "#0a0a0c",
    color: "#e8e8ea",
    fontFamily: "ui-sans-serif, system-ui, -apple-system, sans-serif",
    padding: "40px 20px",
  },
  wrap: { maxWidth: 720, margin: "0 auto" },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 28,
    gap: 12,
  },
  h1: { margin: 0, fontSize: 30, letterSpacing: -0.8, fontWeight: 700 },
  sub: { margin: "6px 0 0", opacity: 0.45, fontSize: 14 },
  badge: {
    textAlign: "right",
    background: "#141418",
    border: "1px solid #232329",
    borderRadius: 10,
    padding: "10px 14px",
  },
  tabs: { display: "flex", gap: 6, marginBottom: 16 },
  tab: {
    flex: 1,
    padding: "10px 0",
    background: "transparent",
    color: "#8a8a94",
    border: "1px solid #232329",
    borderRadius: 8,
    cursor: "pointer",
    fontSize: 14,
  },
  tabOn: { background: "#1a1a20", color: "#fff", borderColor: "#3a3a44" },
  card: {
    background: "#101014",
    border: "1px solid #1e1e24",
    borderRadius: 14,
    padding: 22,
  },
  row: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" },
  input: {
    flex: 1,
    minWidth: 140,
    padding: "11px 13px",
    background: "#08080a",
    border: "1px solid #26262e",
    borderRadius: 8,
    color: "#e8e8ea",
    fontSize: 15,
    outline: "none",
  },
  tld: { opacity: 0.4, fontSize: 15 },
  btn: {
    padding: "11px 18px",
    background: "#e8e8ea",
    color: "#0a0a0c",
    border: "none",
    borderRadius: 8,
    fontWeight: 600,
    cursor: "pointer",
    fontSize: 14,
  },
  btnGhost: {
    padding: "11px 16px",
    background: "transparent",
    color: "#c8c8d0",
    border: "1px solid #2e2e38",
    borderRadius: 8,
    cursor: "pointer",
    fontSize: 14,
  },
  steps: { display: "grid", gap: 12, marginTop: 20 },
  stepBox: {
    background: "#0c0c10",
    border: "1px solid #1e1e24",
    borderRadius: 10,
    padding: 16,
  },
  stepDone: { borderColor: "#2e4a3a" },
  stepText: { fontSize: 13, opacity: 0.55, lineHeight: 1.6, margin: "8px 0 12px" },
  note: {
    marginTop: 18,
    fontSize: 13,
    opacity: 0.5,
    lineHeight: 1.7,
    borderLeft: "2px solid #2e2e38",
    paddingLeft: 12,
  },
  result: { marginTop: 14, fontFamily: "monospace", fontSize: 15, wordBreak: "break-all" },
  fields: { display: "grid", gap: 8, marginTop: 18 },
  field: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    background: "#0c0c10",
    border: "1px solid #1e1e24",
    borderRadius: 10,
    padding: "12px 14px",
  },
  logBox: {
    marginTop: 16,
    background: "#08080a",
    border: "1px solid #1a1a20",
    borderRadius: 10,
    padding: 14,
    fontFamily: "monospace",
    fontSize: 12,
    lineHeight: 1.8,
    maxHeight: 180,
    overflowY: "auto",
  },
};
