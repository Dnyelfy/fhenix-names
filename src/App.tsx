import { useEffect, useMemo, useState } from "react";
import { BrowserProvider, Contract, keccak256, toUtf8Bytes, JsonRpcSigner } from "ethers";
import { cofhejs, Encryptable, FheTypes } from "cofhejs/web";

const FHENIX_NAMES_ADDRESS = "0xD0021bc4f0E4f9ad6F6FAb60151fFf5F335977EB";
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
  { label: "Email", key: "email" },
  { label: "Note", key: "note" },
];

// en fazla 16 byte metni uint128'e cevirir
function textToUint(s: string): bigint {
  const b = toUtf8Bytes(s);
  if (b.length > 16) throw new Error("Max 16 characters");
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

  // ------------------------------------------------------------- connect

  async function connect() {
    const eth = (window as any).ethereum;
    if (!eth) return say("No wallet found");

    const provider = new BrowserProvider(eth, "any");
    await provider.send("eth_requestAccounts", []);

    let net = await provider.getNetwork();
    if (Number(net.chainId) !== ARB_SEPOLIA) {
      say("Switching to Arbitrum Sepolia...");
      try {
        await eth.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: "0x66eee" }],
        });
      } catch (err: any) {
        // 4902 = chain not added to the wallet yet
        if (err?.code === 4902) {
          try {
            await eth.request({
              method: "wallet_addEthereumChain",
              params: [
                {
                  chainId: "0x66eee",
                  chainName: "Arbitrum Sepolia",
                  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
                  rpcUrls: ["https://sepolia-rollup.arbitrum.io/rpc"],
                  blockExplorerUrls: ["https://sepolia.arbiscan.io"],
                },
              ],
            });
          } catch {
            return say("Please switch to Arbitrum Sepolia manually");
          }
        } else {
          return say("Please switch to Arbitrum Sepolia manually");
        }
      }
      // give the wallet a moment to settle on the new chain
      await new Promise((r) => setTimeout(r, 600));
    }

    // rebuild the provider AFTER the switch, otherwise ethers keeps the old
    // chainId and throws "network changed" on every call
    const p2 = new BrowserProvider(eth, "any");
    net = await p2.getNetwork();
    if (Number(net.chainId) !== ARB_SEPOLIA) {
      return say(`Wrong network (${Number(net.chainId)}). Switch to Arbitrum Sepolia and reconnect.`);
    }

    const s = await p2.getSigner();
    setSigner(s);
    setAccount(await s.getAddress());
    say("Wallet connected");

    say("Initializing CoFHE (first run may take 10-20s)");
    try {
      const r: any = await cofhejs.initializeWithEthers({
        ethersProvider: p2,
        ethersSigner: s,
        environment: "TESTNET",
      });
      if (r && r.success === false) throw new Error(r.error?.message || "init failed");
      setReady(true);
      say("CoFHE ready");
    } catch (e: any) {
      say("CoFHE error: " + (e?.message || String(e)));
    }
  }

  useEffect(() => {
    if (!contract || !account) return;
    contract.reverse(account).then(setMyName).catch(() => {});
  }, [contract, account]);

  // wallet-level chain or account switches invalidate the provider entirely
  useEffect(() => {
    const eth = (window as any).ethereum;
    if (!eth?.on) return;
    const reload = () => window.location.reload();
    eth.on("chainChanged", reload);
    eth.on("accountsChanged", reload);
    return () => {
      eth.removeListener?.("chainChanged", reload);
      eth.removeListener?.("accountsChanged", reload);
    };
  }, []);

  // ------------------------------------------------------ 1. registration

  const [name, setName] = useState("");
  const [step, setStep] = useState<Step>("idle");
  const [claimId, setClaimId] = useState<bigint | null>(null);
  const [decReady, setDecReady] = useState(false);

  async function checkAvailable() {
    if (!contract) return;
    try {
      const ok = await contract.isAvailable(name);
      say(ok ? `${name}.fhenix is available` : `${name}.fhenix is taken or invalid`);
    } catch (e: any) {
      say("Error: " + e.message);
    }
  }

  async function doClaim() {
    if (!contract || !ready) return;
    try {
      setStep("encrypting");
      const h = BigInt(keccak256(toUtf8Bytes(name)));
      const hi = h >> 128n;
      const lo = h & MASK128;

      say("Splitting name hash in two and encrypting");
      const enc: any = await cofhejs.encrypt(() => {}, [
        Encryptable.uint128(hi),
        Encryptable.uint128(lo),
      ]);
      if (enc && enc.success === false) throw new Error(enc.error?.message);
      const [encHi, encLo] = enc.data;

      setStep("claiming");
      const tx = await contract.claim(encHi, encLo);
      say("claim sent: " + tx.hash.slice(0, 18) + "...");
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
      say(`Claim recorded, id = ${id}. Order locked on-chain.`);
      setStep("waiting");
    } catch (e: any) {
      setStep("idle");
      say("Error: " + (e.shortMessage || e.message));
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
          say("Coprocessor decrypted, you can settle now");
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
      say("settle sent: " + tx.hash.slice(0, 18) + "...");
      await tx.wait();
      setStep("done");
      setMyName(name);
      say(`${name}.fhenix registered`);
    } catch (e: any) {
      setStep("waiting");
      const m = e.shortMessage || e.message || "";
      if (m.includes("DecryptPending")) say("Not decrypted yet, wait a few more seconds");
      else if (m.includes("NameTaken")) say("Name already taken by someone else");
      else if (m.includes("HashMismatch")) say("Name differs from the one you claimed");
      else say("Error: " + m);
    }
  }

  // ------------------------------------------------------------ 2. resolve

  const [lookup, setLookup] = useState("");
  const [lookupResult, setLookupResult] = useState("");

  async function doLookup() {
    if (!contract) return;
    try {
      if (lookup.startsWith("0x")) {
        const n = await contract.reverse(lookup);
        setLookupResult(n ? `${n}.fhenix` : "no record");
      } else {
        const a = await contract.resolve(lookup);
        setLookupResult(
          a === "0x0000000000000000000000000000000000000000" ? "no record" : a
        );
      }
    } catch (e: any) {
      setLookupResult("error: " + e.message);
    }
  }

  // ---------------------------------------------------- 3. private profile

  const [fieldKey, setFieldKey] = useState("telegram");
  const [fieldValue, setFieldValue] = useState("");
  const [viewer, setViewer] = useState("");
  const [decrypted, setDecrypted] = useState<Record<string, string>>({});

  const keyHash = (k: string) => keccak256(toUtf8Bytes(k));

  async function saveField() {
    if (!contract || !ready || !myName) return;
    try {
      say("Encrypting field");
      const v = textToUint(fieldValue);
      const enc: any = await cofhejs.encrypt(() => {}, [Encryptable.uint128(v)]);
      if (enc && enc.success === false) throw new Error(enc.error?.message);

      const tx = await contract.setProfile(myName, keyHash(fieldKey), enc.data[0]);
      await tx.wait();
      say(`${fieldKey} saved encrypted`);
    } catch (e: any) {
      say("Error: " + (e.shortMessage || e.message));
    }
  }

  async function readField(k: string) {
    if (!contract || !ready || !myName) return;
    try {
      const handle = await contract.getProfile(myName, keyHash(k));
      if (handle === 0n) return say(`${k} is empty`);

      const r: any = await cofhejs.unseal(handle, FheTypes.Uint128);
      if (r && r.success === false) throw new Error(r.error?.message);

      setDecrypted((d) => ({ ...d, [k]: uintToText(BigInt(r.data)) }));
      say(`${k} decrypted, in your browser only`);
    } catch (e: any) {
      say("Error: " + (e.shortMessage || e.message));
    }
  }

  async function share() {
    if (!contract || !myName) return;
    try {
      const tx = await contract.shareProfile(myName, keyHash(fieldKey), viewer);
      await tx.wait();
      say(`${viewer.slice(0, 10)}... can now decrypt ${fieldKey}`);
    } catch (e: any) {
      say("Error: " + (e.shortMessage || e.message));
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
            <p style={S.sub}>Front-run resistant name registration · Fhenix CoFHE</p>
          </div>
          {account ? (
            <div style={S.badge}>
              <div style={{ fontWeight: 600 }}>{myName ? `${myName}.fhenix` : "no name"}</div>
              <div style={{ opacity: 0.5, fontSize: 12 }}>
                {account.slice(0, 6)}...{account.slice(-4)}
              </div>
            </div>
          ) : (
            <button style={S.btn} onClick={connect}>
              Connect wallet
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
              {t === "register" ? "Register" : t === "lookup" ? "Resolve" : "Private profile"}
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
                Check
              </button>
            </div>

            <div style={S.steps}>
              <div style={{ ...S.stepBox, ...(claimId ? S.stepDone : {}) }}>
                <b>1 · Encrypted claim</b>
                <p style={S.stepText}>
                  keccak256(name) is split in two and encrypted in your browser. A bot
                  watching the mempool sees only ciphertext handles and cannot recover the
                  name. Your position in line is locked by this transaction.
                </p>
                <button
                  style={S.btn}
                  disabled={!ready || !name || step === "claiming" || step === "encrypting"}
                  onClick={doClaim}
                >
                  {step === "encrypting"
                    ? "Encrypting..."
                    : step === "claiming"
                    ? "Sending..."
                    : "Claim"}
                </button>
              </div>

              <div style={{ ...S.stepBox, ...(claimId ? {} : { opacity: 0.35 }) }}>
                <b>2 · Settle</b>
                <p style={S.stepText}>
                  {claimId && !decReady
                    ? "Coprocessor is decrypting, hold on..."
                    : "You send the name in the clear and the contract verifies it with keccak. Since order was fixed in step 1, revealing the name here is harmless."}
                </p>
                <button
                  style={S.btn}
                  disabled={claimId === null || !decReady || step === "settling"}
                  onClick={doSettle}
                >
                  {step === "settling" ? "Registering..." : "Settle"}
                </button>
              </div>
            </div>

            <div style={S.note}>
              ENS has to use commit-reveal here: two transactions, a 60 second wait, and
              the user must keep a secret locally. There is no secret to keep here.
            </div>
          </div>
        )}

        {tab === "lookup" && (
          <div style={S.card}>
            <div style={S.row}>
              <input
                style={S.input}
                placeholder="name or 0x address"
                value={lookup}
                onChange={(e) => setLookup(e.target.value)}
              />
              <button style={S.btn} onClick={doLookup}>
                Resolve
              </button>
            </div>
            {lookupResult && <div style={S.result}>{lookupResult}</div>}
          </div>
        )}

        {tab === "profile" && (
          <div style={S.card}>
            {!myName ? (
              <div style={S.note}>Register a name first.</div>
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
                    placeholder="value (max 16 characters)"
                    value={fieldValue}
                    onChange={(e) => setFieldValue(e.target.value)}
                  />
                  <button style={S.btn} onClick={saveField}>
                    Encrypt and save
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
                          {decrypted[f.key] ?? "••••••••  (encrypted on-chain)"}
                        </div>
                      </div>
                      <button style={S.btnGhost} onClick={() => readField(f.key)}>
                        Decrypt
                      </button>
                    </div>
                  ))}
                </div>

                <div style={{ ...S.row, marginTop: 20 }}>
                  <input
                    style={S.input}
                    placeholder="0x... address to grant"
                    value={viewer}
                    onChange={(e) => setViewer(e.target.value)}
                  />
                  <button style={S.btnGhost} onClick={share}>
                    Grant access
                  </button>
                </div>

                <div style={S.note}>
                  Fields are stored on-chain as ciphertext. By default only you can decrypt
                  them. An address you grant decrypts in its own browser; the value is never
                  exposed on-chain.
                </div>
              </>
            )}
          </div>
        )}

        <div style={S.logBox}>
          {log.length === 0 ? (
            <div style={{ opacity: 0.35 }}>activity log</div>
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
