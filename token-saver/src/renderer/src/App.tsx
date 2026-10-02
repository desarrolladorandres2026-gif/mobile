import { useCallback, useEffect, useState } from "react";
import { FolderOpen, Copy, Check, Loader2 } from "lucide-react";
import type { FileMap, OptimizationMode, OptimizationResult, TaskHistoryEntry } from "../../shared/types";

const MODES: { value: OptimizationMode; label: string; description: string }[] = [
  { value: "normal", label: "Normal", description: "equilibrio entre contexto y ahorro" },
  { value: "inteligente", label: "Inteligente", description: "ajusta el contexto según la tarea" },
  { value: "agresivo", label: "Agresivo", description: "mínimo contexto posible" },
  { value: "completo", label: "Completo", description: "más contexto si la tarea es compleja" },
];

export default function App() {
  const [root, setRoot] = useState<string | null>(null);
  const [fileMap, setFileMap] = useState<FileMap | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState<{ scanned: number; total: number } | null>(null);
  const [task, setTask] = useState("");
  const [mode, setMode] = useState<OptimizationMode>("inteligente");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<OptimizationResult | null>(null);
  const [history, setHistory] = useState<TaskHistoryEntry[]>([]);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    window.tokenSaver.onScanProgress(setScanProgress);
  }, []);

  const handleSelectFolder = useCallback(async () => {
    const selected = await window.tokenSaver.selectFolder();
    if (!selected) return;
    setRoot(selected);
    setFileMap(null);
    setResult(null);
    setError(null);
    setScanning(true);
    try {
      const { fileMap: map, history: loadedHistory } = await window.tokenSaver.scanProject(selected);
      setFileMap(map);
      setHistory(loadedHistory);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al escanear el proyecto");
    } finally {
      setScanning(false);
      setScanProgress(null);
    }
  }, []);

  const handleOptimize = useCallback(async () => {
    if (!root || !task.trim()) return;
    setRunning(true);
    setError(null);
    try {
      const optimized = await window.tokenSaver.runTask(root, task.trim(), mode);
      setResult(optimized);
      const updatedHistory = await window.tokenSaver.getHistory(root);
      setHistory(updatedHistory);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al optimizar la tarea");
    } finally {
      setRunning(false);
    }
  }, [root, task, mode]);

  const handleCopy = useCallback(async () => {
    if (!result) return;
    await navigator.clipboard.writeText(result.prompt);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [result]);

  return (
    <div className="min-h-screen bg-white text-neutral-900">
      <div className="mx-auto max-w-5xl px-8 py-10">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">Token Saver Agent</h1>
          <p className="mt-1 text-sm text-neutral-600">
            Selecciona el contexto mínimo necesario antes de enviar una tarea a Claude Code.
          </p>
        </header>

        <section className="mt-8 flex items-center gap-4">
          <button
            onClick={handleSelectFolder}
            className="inline-flex items-center gap-2 rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium hover:border-neutral-500"
          >
            <FolderOpen size={16} />
            {root ? "Cambiar proyecto" : "Seleccionar proyecto"}
          </button>
          {root && <span className="text-sm text-neutral-700 truncate">{root}</span>}
        </section>

        {scanning && (
          <p className="mt-4 flex items-center gap-2 text-sm text-neutral-700">
            <Loader2 size={14} className="animate-spin" />
            Escaneando{scanProgress ? ` — ${scanProgress.scanned}/${scanProgress.total} archivos` : "…"}
          </p>
        )}

        {fileMap && !scanning && (
          <p className="mt-4 text-sm text-neutral-700">
            {fileMap.files.length} archivos indexados · {fileMap.hasGit ? "Git detectado" : "sin Git"}
          </p>
        )}

        {error && <p className="mt-4 text-sm text-red-700">{error}</p>}

        {fileMap && (
          <>
            <div className="mt-10 border-t border-neutral-200 pt-8">
              <h2 className="text-lg font-medium">Tarea</h2>
              <textarea
                value={task}
                onChange={(e) => setTask(e.target.value)}
                placeholder="Ej. Corrige el sistema de autenticación."
                rows={3}
                className="mt-3 w-full resize-none rounded-md border border-neutral-300 px-3 py-2 text-sm focus:border-neutral-600 focus:outline-none"
              />

              <div className="mt-4 flex flex-wrap gap-2">
                {MODES.map((m) => (
                  <button
                    key={m.value}
                    onClick={() => setMode(m.value)}
                    title={m.description}
                    className={`rounded-md border px-3 py-1.5 text-sm ${
                      mode === m.value
                        ? "border-neutral-900 font-medium"
                        : "border-neutral-300 text-neutral-700 hover:border-neutral-500"
                    }`}
                  >
                    {m.label}
                  </button>
                ))}
              </div>

              <button
                onClick={handleOptimize}
                disabled={!task.trim() || running}
                className="mt-5 inline-flex items-center gap-2 rounded-md bg-neutral-900 px-5 py-2.5 text-sm font-medium text-white disabled:opacity-40"
              >
                {running && <Loader2 size={14} className="animate-spin" />}
                Optimizar tarea
              </button>
            </div>

            {result && <ResultView result={result} onCopy={handleCopy} copied={copied} />}

            {history.length > 0 && (
              <div className="mt-12 border-t border-neutral-200 pt-8">
                <h2 className="text-lg font-medium">Historial</h2>
                <ul className="mt-4 divide-y divide-neutral-200">
                  {history.slice(0, 10).map((entry) => (
                    <li key={entry.id} className="py-3 text-sm">
                      <p className="font-medium">{entry.task}</p>
                      <p className="mt-0.5 text-neutral-600">
                        {new Date(entry.createdAt).toLocaleString()} · modo {entry.mode} · ahorro{" "}
                        {entry.savingsPercent}%
                      </p>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function ResultView({
  result,
  onCopy,
  copied,
}: {
  result: OptimizationResult;
  onCopy: () => void;
  copied: boolean;
}) {
  const included = result.files.filter((f) => f.included);
  const excluded = result.files.filter((f) => !f.included);

  return (
    <div className="mt-10 border-t border-neutral-200 pt-8">
      <h2 className="text-lg font-medium">Resultado</h2>

      <dl className="mt-4 grid grid-cols-4 gap-6 text-sm">
        <div>
          <dt className="text-neutral-600">Sin optimización</dt>
          <dd className="mt-1 text-xl font-semibold">{result.tokensWithoutOptimization.toLocaleString()}</dd>
        </div>
        <div>
          <dt className="text-neutral-600">Contexto seleccionado</dt>
          <dd className="mt-1 text-xl font-semibold">{result.tokensSelected.toLocaleString()}</dd>
        </div>
        <div>
          <dt className="text-neutral-600">Ahorro estimado</dt>
          <dd className="mt-1 text-xl font-semibold">{result.tokensSaved.toLocaleString()}</dd>
        </div>
        <div>
          <dt className="text-neutral-600">Ahorro</dt>
          <dd className="mt-1 text-xl font-semibold">{result.savingsPercent}%</dd>
        </div>
      </dl>
      <p className="mt-2 text-xs text-neutral-500">Estimación aproximada (chars/4), no el tokenizer real.</p>

      <div className="mt-8 grid grid-cols-2 gap-8">
        <div>
          <h3 className="text-sm font-medium">Incluido ({included.length})</h3>
          <ul className="mt-2 space-y-2">
            {included.map((f) => (
              <li key={f.path} className="text-sm">
                <p className="flex items-center gap-1.5">
                  <Check size={14} className="text-emerald-700" />
                  <span className="font-medium">{f.path}</span>
                </p>
                <p className="ml-5 text-neutral-600">{f.reason}</p>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h3 className="text-sm font-medium">Excluido ({excluded.length})</h3>
          <ul className="mt-2 space-y-2">
            {excluded.map((f) => (
              <li key={f.path} className="text-sm">
                <p className="font-medium text-neutral-700">○ {f.path}</p>
                <p className="ml-5 text-neutral-600">{f.reason}</p>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="mt-8">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">Prompt generado</h3>
          <button
            onClick={onCopy}
            className="inline-flex items-center gap-1.5 rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium hover:border-neutral-500"
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}
            {copied ? "Copiado" : "Copiar prompt"}
          </button>
        </div>
        <pre className="mt-3 whitespace-pre-wrap border-t border-neutral-200 pt-3 text-sm font-mono">
          {result.prompt}
        </pre>
      </div>
    </div>
  );
}
