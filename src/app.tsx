import '@patternfly/react-core/dist/styles/base.css';
import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { CronExpressionParser } from "cron-parser";
import cockpit from "cockpit";
import {
  Page, PageSection, Title, Button, TextArea, Alert, AlertGroup, Stack, StackItem,
  Form, FormGroup, TextInput, Tooltip, Spinner, Switch, FormHelperText, Badge
} from "@patternfly/react-core";
import {
  Table, Thead, Tbody, Tr, Th, Td
} from '@patternfly/react-table';
import { SyncAltIcon, SaveIcon, PlusIcon, MinusCircleIcon, PlayIcon, PlayCircleIcon, CheckIcon } from '@patternfly/react-icons';
import "./app.scss";

type IntervalRow = {
  id: string;
  name: string;
  count: string;
  cronSyntax: string;
  active: boolean;
};

type BackupJob = {
  source: string;
  dest: string;
  options: string;
};

const CRON_PATH = "/etc/cron.d/rsnapshot";
const CONF_PATH = "/etc/rsnapshot.conf";

function newId() {
  return (window.crypto?.randomUUID?.() || Math.random().toString(36).slice(2));
}

const DEFAULT_INTERVALS: IntervalRow[] = [
  { id: newId(), name: "hourly", count: "", cronSyntax: "0 * * * *", active: false },
  { id: newId(), name: "daily", count: "", cronSyntax: "30 3 * * *", active: false },
  { id: newId(), name: "weekly", count: "", cronSyntax: "0 3 * * 1", active: false },
  { id: newId(), name: "monthly", count: "", cronSyntax: "30 2 1 * *", active: false }
];

function parseConfig(conf: string): {
  snapshot_root: string;
  logfile: string;
  verbose: string;
  intervals: IntervalRow[];
  backups: BackupJob[];
  excludes: string[];
  rest: string[];
  rawLines: string[];
} {
  const lines = conf.split("\n");
  const result = {
    snapshot_root: "",
    logfile: "",
    verbose: "",
    intervals: [] as IntervalRow[],
    backups: [] as BackupJob[],
    excludes: [] as string[],
    rest: [] as string[],
    rawLines: lines
  };
  const intervalMap: Record<string, IntervalRow> = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const commentIdx = trimmed.indexOf("#");
    const cleanLine = commentIdx >= 0 ? trimmed.slice(0, commentIdx).trim() : trimmed;
    if (cleanLine.startsWith("snapshot_root")) result.snapshot_root = cleanLine.split(/\s+/)[1] || "";
    else if (cleanLine.startsWith("logfile")) result.logfile = cleanLine.split(/\s+/)[1] || "";
    else if (cleanLine.startsWith("verbose")) result.verbose = cleanLine.split(/\s+/)[1] || "";
    else if (/^(retain|interval)\s+/.test(cleanLine)) {
      const [, name, count] = cleanLine.split(/\s+/);
      if (name) {
        intervalMap[name] = {
          id: newId(),
          name,
          count,
          cronSyntax: "",
          active: !trimmed.startsWith("#")
        };
      }
    } else if (cleanLine.startsWith("backup")) {
      const [, source, dest, ...opts] = cleanLine.split(/\s+/);
      result.backups.push({ source, dest, options: opts.join(" ") });
    } else if (cleanLine.startsWith("exclude")) {
      result.excludes.push(cleanLine.replace(/^exclude\s+/, ""));
    } else if (cleanLine.startsWith("exclude_file")) {
      result.excludes.push("file:" + cleanLine.replace(/^exclude_file\s+/, ""));
    } else if (cleanLine) {
      result.rest.push(line);
    }
  }
  result.intervals = Object.values(intervalMap);
  if (result.intervals.length === 0) {
    result.intervals.push({
      id: newId(),
      name: "custom",
      count: "1",
      cronSyntax: "0 0 * * *",
      active: false
    });
  }
  return result;
}

function parseCron(cron: string, intervals: IntervalRow[]): IntervalRow[] {
  const cronMap: Record<string, { cronSyntax: string; active: boolean }> = {};
  intervals.forEach(i => {
    cronMap[i.name] = { cronSyntax: i.cronSyntax || "", active: false };
  });
  cron.split("\n").forEach(line => {
    if (/^\s*#/.test(line)) return;
    const trimmed = line.trim();
    intervals.forEach(interval => {
      if (trimmed.includes(`rsnapshot ${interval.name}`)) {
        cronMap[interval.name] = {
          cronSyntax: trimmed.split(/\s+root/)[0].trim(),
          active: true
        };
      }
    });
  });
  return intervals.map(i => ({
    ...i,
    cronSyntax: cronMap[i.name]?.cronSyntax || i.cronSyntax,
    active: cronMap[i.name]?.active ?? i.active
  }));
}

function serializeConfig(parsed: any, intervalRows: IntervalRow[]) {
  const lines: string[] = [];
  if (parsed.snapshot_root) lines.push(`snapshot_root\t${parsed.snapshot_root}`);
  if (parsed.logfile) lines.push(`logfile\t${parsed.logfile}`);
  if (parsed.verbose) lines.push(`verbose\t${parsed.verbose}`);
  intervalRows.forEach(row => {
    if (row.count) {
      const line = `retain\t${row.name}\t${row.count}`;
      lines.push(row.active ? line : `#${line}`);
    }
  });
  parsed.backups.forEach((b: BackupJob) => {
    if (b.source && b.dest) lines.push(`backup\t${b.source}\t${b.dest}\t${b.options}`);
  });
  parsed.excludes.forEach((e: string) => {
    if (e) lines.push(e.startsWith("file:") ? `exclude_file\t${e.slice(5)}` : `exclude\t${e}`);
  });
  if (parsed.rest.length) lines.push(...parsed.rest);
  return lines.join("\n");
}

function serializeCronFile(intervalRows: IntervalRow[]) {
  let cron = "# Managed by Cockpit rsnapshot Plugin\n";
  intervalRows.forEach(row => {
    if (!row.cronSyntax) return;
    const line = `${row.cronSyntax} root /usr/bin/rsnapshot ${row.name}`;
    cron += row.active ? `${line}\n` : `#${line}\n`;
  });
  return cron;
}

function isValidCronSyntax(s: string): boolean {
  const shortcuts = ["@reboot", "@yearly", "@annually", "@monthly", "@weekly", "@daily", "@hourly"];
  if (shortcuts.includes(s.trim())) return true;
  return /^([\d\/*,\-]+)\s+([\d\/*,\-]+)\s+([\d\/*,\-]+)\s+([\d\/*,\-]+)\s+([\d\/*,\-]+)$/.test(s.trim());
}

function isValidCount(v: string) {
  return /^\d+$/.test(v) && Number(v) > 0;
}

function getNextCronRun(cron: string): string {
  try {
    const shortcutMap: Record<string, string> = {
      "@hourly": "0 * * * *",
      "@daily": "0 0 * * *",
      "@weekly": "0 0 * * 0",
      "@monthly": "0 0 1 * *",
      "@yearly": "0 0 1 1 *",
      "@annually": "0 0 1 1 *",
      "@reboot": "",
    };
    const cronExpr = shortcutMap[cron.trim()] || cron;
    if (!cronExpr) return "Wird beim Systemstart ausgeführt";
    const interval = CronExpressionParser.parse(cronExpr, {
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone
    });
    const next = interval.next();
    return "Nächster Lauf: " + next.toDate().toLocaleString();
  } catch (e) {
    return "Fehler: " + e;
  }
}

function hasSudoRights(): Promise<boolean> {
  return cockpit.spawn(["true"], { superuser: "require" }).then(() => true).catch(() => false);
}

function isValidBackupJob(b: BackupJob): boolean {
  return !!b.source && !!b.dest && b.source.trim() !== "" && b.dest.trim() !== "";
}

function getActiveRetainMap(conf: string): Record<string, { count: string; active: boolean }> {
  const map: Record<string, { count: string; active: boolean }> = {};
  conf.split("\n").forEach(line => {
    const trimmed = line.trim();
    if (/^(retain|interval)\s+/.test(trimmed)) {
      const isActive = !trimmed.startsWith("#");
      const [, name, count] = trimmed.replace(/^#/, "").split(/\s+/);
      if (name) map[name] = { count: count || "", active: isActive };
    }
  });
  return map;
}

function getActiveCronMap(cron: string): Record<string, { cronSyntax: string; active: boolean }> {
  const map: Record<string, { cronSyntax: string; active: boolean }> = {};
  cron.split("\n").forEach(line => {
    if (/^\s*#/.test(line)) return;
    const trimmed = line.trim();
    const m = trimmed.match(/^(.+?)\s+root\s+\/usr\/bin\/rsnapshot\s+(\S+)/);
    if (m) {
      const cronSyntax = m[1];
      const name = m[2];
      map[name] = { cronSyntax, active: true };
    }
  });
  return map;
}

const App: React.FC = () => {
  const [rsnapshotAvailable, setRsnapshotAvailable] = useState<boolean | null>(null);
  const [sudoAvailable, setSudoAvailable] = useState<boolean | null>(null);
  const [output, setOutput] = useState("");
  const [alerts, setAlerts] = useState<{title: string, variant: 'success'|'danger'|'warning'}[]>([]);
  const [isSavingConfig, setIsSavingConfig] = useState(false);
  const [successFlash, setSuccessFlash] = useState(false);

  const [snapshotRoot, setSnapshotRoot] = useState("");
  const [snapshotRootStatus, setSnapshotRootStatus] = useState<"ok"|"notfound"|"notwritable"|"empty"|"error">("empty");
  const [snapshotRootStatusMsg, setSnapshotRootStatusMsg] = useState<string>("");

  const [logfile, setLogfile] = useState("");
  const [verbose, setVerbose] = useState("");
  const [intervalRows, setIntervalRows] = useState<IntervalRow[]>([...DEFAULT_INTERVALS]);
  const [cronErrors, setCronErrors] = useState<{[key: string]: string|undefined}>({});
  const [countErrors, setCountErrors] = useState<{[key: string]: string|undefined}>({});
  const [backups, setBackups] = useState<BackupJob[]>([]);
  const [excludes, setExcludes] = useState<string[]>([]);
  const [rest, setRest] = useState<string[]>([]);

  const [rawConf, setRawConf] = useState("");
  const [rawCron, setRawCron] = useState("");
  const [isSavingRawConf, setIsSavingRawConf] = useState(false);
  const [isSavingRawCron, setIsSavingRawCron] = useState(false);

  const [manualConfWarn, setManualConfWarn] = useState<string[]>([]);
  const [lastBackupInfo, setLastBackupInfo] = useState<string>("");

  const [cronPreview, setCronPreview] = useState<{[key: string]: string}>({});

  // Refs für Tabulator-Workaround
  const rawConfRef = useRef<HTMLTextAreaElement>(null);
  const restRef = useRef<HTMLTextAreaElement>(null);

  // Snapshot Root prüfen
  const checkSnapshotRoot = useCallback((dir: string) => {
    if (!dir || dir.trim() === "") {
      setSnapshotRootStatus("empty");
      setSnapshotRootStatusMsg("Bitte angeben");
      return;
    }
    cockpit.spawn([ "bash", "-c", `[ -d "${dir.replace(/"/g, '\\"')}" ] && [ -w "${dir.replace(/"/g, '\\"')}" ] && echo OK || ( [ -d "${dir.replace(/"/g, '\\"')}" ] && echo NOWRITE || echo NOEXIST )` ])
      .then((out: string) => {
        if (out.trim() === "OK") {
          setSnapshotRootStatus("ok");
          setSnapshotRootStatusMsg("Verzeichnis existiert und ist beschreibbar.");
        } else if (out.trim() === "NOWRITE") {
          setSnapshotRootStatus("notwritable");
          setSnapshotRootStatusMsg("Verzeichnis existiert, ist aber nicht beschreibbar!");
        } else {
          setSnapshotRootStatus("notfound");
          setSnapshotRootStatusMsg("Verzeichnis existiert nicht! rsnapshot wird das Verzeichnis anlegen (Ausnahme: no_create_root 1).");
        }
      })
      .catch((err: any) => {
        setSnapshotRootStatus("error");
        setSnapshotRootStatusMsg("Fehler bei der Prüfung: " + (err?.message || err));
      });
  }, []);

  useEffect(() => {
    checkSnapshotRoot(snapshotRoot);
  }, [snapshotRoot, checkSnapshotRoot]);

  // Configtest ausführen
  const runConfigTest = useCallback(() => {
    setOutput(prev => prev + "Starte rsnapshot configtest...\n");
    cockpit.spawn(["rsnapshot", "configtest"], { superuser: "require", err: "message" })
      .then(data => {
        setOutput(prev => prev + data + "\n");
        setAlerts(alerts => [...alerts, { title: "Configtest erfolgreich", variant: "success" }]);
      })
      .catch(error => {
        setOutput(prev =>
          prev +
          "Fehler beim configtest: " +
          (error?.message || "") +
          (error?.problem ? "\n" + error.problem : "") +
          (error?.stderr ? "\n" + error.stderr : "") +
          "\n"
        );
        setAlerts(alerts => [...alerts, { title: "Fehler beim Configtest – Details siehe Log unten", variant: "danger" }]);
      });
  }, []);

  // Gemeinsames Laden und Mergen!
  const loadAll = useCallback(() => {
    Promise.all([
      cockpit.spawn(["cat", CONF_PATH]),
      cockpit.spawn(["cat", CRON_PATH]).catch(() => "")
    ]).then(([confData, cronData]) => {
      setRawConf(confData);
      setRawCron(cronData);

      // Config parsen
      const parsedConfig = parseConfig(confData);
      setSnapshotRoot(parsedConfig.snapshot_root);
      setLogfile(parsedConfig.logfile);
      setVerbose(parsedConfig.verbose);
      setBackups(parsedConfig.backups.filter(isValidBackupJob));
      setExcludes(parsedConfig.excludes.filter(e => e));
      setRest(parsedConfig.rest);

      // Intervalle aus Cron mergen
      const mergedIntervals = parseCron(cronData, parsedConfig.intervals);
      setIntervalRows(mergedIntervals);
    });
    loadLastBackup();
    // eslint-disable-next-line
  }, []);
  

  useEffect(() => {
    cockpit.spawn(["which", "rsnapshot"])
      .then(() => setRsnapshotAvailable(true))
      .catch(() => setRsnapshotAvailable(false));
    hasSudoRights().then(setSudoAvailable);
    loadAll();
    // eslint-disable-next-line
  }, []);

  const loadLastBackup = useCallback(() => {
    if (!snapshotRoot) {
      setLastBackupInfo("");
      return;
    }
    cockpit.spawn(["bash", "-c", `ls -1dt ${snapshotRoot}/*/ 2>/dev/null | head -1`])
      .then(dir => {
        if (!dir.trim()) {
          setLastBackupInfo("Kein Backup gefunden.");
          return;
        }
        return cockpit.spawn(["stat", "-c", "%y", dir.trim()])
          .then(date => setLastBackupInfo(`${dir.trim()} (letzte Änderung: ${date.trim()})`))
          .catch(() => setLastBackupInfo(dir.trim()));
      })
      .catch(() => setLastBackupInfo("Kein Backup gefunden."));
  }, [snapshotRoot]);

  useEffect(() => {
    loadLastBackup();
  }, [snapshotRoot, loadLastBackup]);


  function saveAll() {
    setIsSavingConfig(true);
    setSuccessFlash(false);
    const confObj: any = {
      snapshot_root: snapshotRoot,
      logfile,
      verbose,
      intervals: {},
      backups: backups.filter(isValidBackupJob),
      excludes: excludes.filter(e => e),
      rest
    };
    intervalRows.forEach(row => {
      confObj.intervals[row.name] = row.count;
    });
    const confText = serializeConfig(confObj, intervalRows);
    const cronText = serializeCronFile(intervalRows);

    Promise.all([
      cockpit.file(CONF_PATH, { superuser: "require" }).replace(confText),
      cockpit.file(CRON_PATH, { superuser: "require" }).replace(cronText)
        .then(() =>
          Promise.all([
            cockpit.spawn(["chown", "root:root", CRON_PATH], { superuser: "require" }),
            cockpit.spawn(["chmod", "0644", CRON_PATH], { superuser: "require" })
          ])
        )
    ])
      .then(() => {
        setAlerts(alerts => [...alerts, {title: "Konfiguration und Cronjobs gespeichert", variant: "success"}]);
        setSuccessFlash(true);
        loadAll();
        setTimeout(() => setSuccessFlash(false), 1000);
        runConfigTest();
      })
      .catch(error => {
        setAlerts(alerts => [
          ...alerts,
          {title: "Fehler beim Speichern: " + (error?.message || JSON.stringify(error)), variant: "danger"}
        ]);
      })
      .finally(() => setIsSavingConfig(false));
  }

  const saveRawConf = useCallback(() => {
    setIsSavingRawConf(true);
    cockpit.file(CONF_PATH, { superuser: "require" }).replace(rawConf)
      .then(() => {
        setAlerts(alerts => [...alerts, {title: "Konfiguration gespeichert", variant: "success"}]);
        loadAll();
      })
      .catch(error => {
        setAlerts(alerts => [
          ...alerts,
          {title: "Fehler beim Speichern der Konfiguration: " + (error?.message || JSON.stringify(error)), variant: "danger"}
        ]);
      })
      .finally(() => setIsSavingRawConf(false));
  }, [rawConf, loadAll]);

  const saveRawCron = useCallback(() => {
    setIsSavingRawCron(true);
    cockpit.file(CRON_PATH, { superuser: "require" }).replace(rawCron)
      .then(() =>
        Promise.all([
          cockpit.spawn(["chown", "root:root", CRON_PATH], { superuser: "require" }),
          cockpit.spawn(["chmod", "0644", CRON_PATH], { superuser: "require" })
        ])
      )
      .then(() => {
        setAlerts(alerts => [...alerts, {title: "Cron-Datei gespeichert", variant: "success"}]);
        loadAll();
      })
      .catch(error => {
        setAlerts(alerts => [
          ...alerts,
          {title: "Fehler beim Speichern der Cron-Datei: " + (error?.message || JSON.stringify(error)), variant: "danger"}
        ]);
      })
      .finally(() => setIsSavingRawCron(false));
  }, [rawCron, loadAll]);

  useEffect(() => {
    const preview: {[key: string]: string} = {};
    intervalRows.forEach((row) => {
      if (row.cronSyntax && isValidCronSyntax(row.cronSyntax)) {
        preview[row.id] = getNextCronRun(row.cronSyntax);
      } else {
        preview[row.id] = "";
      }
    });
    setCronPreview(preview);
  }, [intervalRows]);

  const playButtonStates = useMemo(() => {
    const retainMap = getActiveRetainMap(rawConf);
    const cronMap = getActiveCronMap(rawCron);
    const result: Record<string, { enabled: boolean; reason: string }> = {};
    intervalRows.forEach(row => {
      const retain = retainMap[row.name];
      const cron = cronMap[row.name];
      if (!retain || !retain.active) {
        result[row.id] = {
          enabled: false,
          reason: "Dieses Intervall ist nicht als aktives retain/intervall in rsnapshot.conf gespeichert."
        };
      } else if (!cron || !cron.active) {
        result[row.id] = {
          enabled: false,
          reason: "Dieses Intervall ist nicht als aktiver Cronjob in /etc/cron.d/rsnapshot gespeichert."
        };
      } else if (
        retain.count !== row.count ||
        row.cronSyntax !== cron.cronSyntax ||
        !row.active
      ) {
        result[row.id] = {
          enabled: false,
          reason: "Dieses Intervall ist nicht exakt so gespeichert (Name, Anzahl, Cron-Syntax, Aktiv-Status müssen übereinstimmen)."
        };
      } else {
        result[row.id] = { enabled: true, reason: "" };
      }
    });
    return result;
  }, [intervalRows, rawConf, rawCron]);

  const handleIntervalRow = useCallback((id: string, field: string, value: any) => {
    setIntervalRows(rows =>
      rows.map((row) =>
        row.id === id ? { ...row, [field]: value } : row
      )
    );
    if (field === "cronSyntax") {
      setCronErrors(errors => ({
        ...errors,
        [id]: isValidCronSyntax(value) ? undefined : "Ungültige Cron-Syntax (z.B. 0 * * * * oder @daily)"
      }));
    }
    if (field === "count") {
      setCountErrors(errors => ({
        ...errors,
        [id]: isValidCount(value) || value === "" ? undefined : "Nur positive ganze Zahl erlaubt"
      }));
    }
  }, []);

  const addInterval = useCallback(() => {
    setIntervalRows(rows => [
      ...rows,
      {
        id: newId(),
        name: `custom${rows.length + 1}`,
        count: "1",
        cronSyntax: "0 0 * * *",
        active: false
      }
    ]);
  }, []);

  const removeInterval = useCallback((id: string) => {
    setIntervalRows(rows => rows.length > 1 ? rows.filter(row => row.id !== id) : rows);
  }, []);

  const handleBackup = useCallback((idx: number, field: keyof BackupJob, value: string) => {
    setBackups((prev: BackupJob[]) => {
      const copy = [...prev];
      copy[idx][field] = value;
      return copy;
    });
  }, []);
  const addBackup = useCallback(() => setBackups(prev => [...prev, { source: "", dest: "", options: "" }]), []);
  const removeBackup = useCallback((idx: number) => setBackups(prev => prev.filter((_, i) => i !== idx)), []);

  const handleExclude = useCallback((idx: number, value: string) => {
    setExcludes((prev: string[]) => {
      const copy = [...prev];
      copy[idx] = value;
      return copy;
    });
  }, []);
  const addExclude = useCallback(() => setExcludes(prev => [...prev, ""]), []);
  const removeExclude = useCallback((idx: number) => setExcludes(prev => prev.filter((_, i) => i !== idx)), []);

  const cronTooltip = (
    <span>
      Ungültige Cron-Syntax.<br />
      Beispiele:<br />
      <code>0 * * * *</code> (jede Stunde)<br />
      <code>30 3 * * *</code> (täglich 3:30 Uhr)<br />
      <code>@daily</code>, <code>@hourly</code>
    </span>
  );

  const handleRestTab = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Tab") {
      e.preventDefault();
      const target = e.target as HTMLTextAreaElement;
      const start = target.selectionStart;
      const end = target.selectionEnd;
      const value = rest.join("\n");
      const newValue = value.substring(0, start) + "\t" + value.substring(end);
      setRest(newValue.split("\n"));
      setTimeout(() => {
        if (restRef.current) {
          restRef.current.selectionStart = restRef.current.selectionEnd = start + 1;
        }
      }, 0);
    }
  };

  return (
    <Page>
      <PageSection>
        <Title headingLevel="h1" size="lg">rsnapshot Verwaltung</Title>
        <div style={{marginBottom: 8, color: "#555", fontSize: "1em"}}>
          <strong>rsnapshot</strong> ist ein flexibles Backup-Tool auf Basis von rsync und Hardlinks.<br />
          Dieses Cockpit-Plugin ermöglicht die einfache Verwaltung der wichtigsten Einstellungen, Cronjobs und Backups.<br />
          <a href="https://rsnapshot.org/" target="_blank" rel="noopener noreferrer">Projektseite</a>
        </div>
        <AlertGroup isToast>
          {alerts.map((alert, idx) => (
            <Alert key={idx} title={alert.title} variant={alert.variant} timeout={5000} />
          ))}
        </AlertGroup>
        {rsnapshotAvailable === false && (
          <Alert title="rsnapshot ist nicht installiert" variant="danger" isInline>
            Das Programm <strong>rsnapshot</strong> ist auf diesem System nicht installiert.<br />
            Installieren Sie es z.B. mit:<br />
            <code>sudo apt install rsnapshot</code> (Debian/Ubuntu)<br />
            <code>sudo dnf install rsnapshot</code> (Fedora/RedHat)<br />
            <code>sudo zypper install rsnapshot</code> (openSUSE)
          </Alert>
        )}
        {sudoAvailable === false && (
          <Alert title="Keine sudo-Rechte" variant="danger" isInline>
            Sie haben keine sudo-Rechte oder Ihr Cockpit-Session-User darf keine Systemdateien ändern.<br />
            Bitte führen Sie Cockpit als Administrator aus.
          </Alert>
        )}
        <Stack hasGutter>
          <StackItem>
            <div className={`conf-header${successFlash ? " success-flash" : ""}`} style={{alignItems: "center"}}>
              <strong>rsnapshot Konfiguration:</strong>
              <Tooltip content="Konfiguration laden">
                <Button
                  variant="plain"
                  aria-label="Konfiguration laden"
                  onClick={loadAll}
                  style={{marginLeft: "0.2em"}}
                >
                  <SyncAltIcon />
                </Button>
              </Tooltip>
              <Tooltip content="Konfiguration speichern">
                <Button
                  variant="plain"
                  aria-label="Konfiguration speichern"
                  onClick={saveAll}
                  isDisabled={
                    Object.values(cronErrors).some(Boolean) ||
                    Object.values(countErrors).some(Boolean) ||
                    isSavingConfig
                  }
                  style={{marginLeft: "0.2em"}}
                >
                  {isSavingConfig ? <Spinner size="sm" /> : <SaveIcon />}
                </Button>
              </Tooltip>
              <Tooltip content="Konfiguration testen (rsnapshot configtest)">
                <Button
                  variant="plain"
                  aria-label="Konfiguration testen"
                  onClick={runConfigTest}
                  isDisabled={!rsnapshotAvailable || !sudoAvailable}
                  style={{marginLeft: "0.2em"}}
                >
                  <CheckIcon />
                </Button>
              </Tooltip>
              {successFlash && <Badge style={{marginLeft: 8}} isRead>Gespeichert</Badge>}
            </div>
            <Form>
              <FormGroup label="Snapshot Root" fieldId="snapshot_root">
                <FormHelperText>
                  Verzeichnis, in dem die Backups gespeichert werden. Muss ein lokaler Pfad sein (kein Remote-Pfad, aber z.B. ein gemountetes NFS-Laufwerk ist möglich).
                </FormHelperText>
                <TextInput
                  value={snapshotRoot}
                  onChange={(_, v) => setSnapshotRoot(v)}
                  aria-label="Snapshot Root"
                  placeholder="/mnt/backup/storage/"
                />
                {lastBackupInfo && (
                  <FormHelperText style={{ color: "#0066cc", marginTop: 2 }}>
                    {lastBackupInfo}
                  </FormHelperText>
                )}
              </FormGroup>

              <FormGroup label="Intervalle & Cronjobs" fieldId="intervals">
                <FormHelperText>
                  Definiert, wie viele Snapshots pro Intervall gehalten werden und wann sie laufen. Sie können Intervalle hinzufügen oder entfernen.
                </FormHelperText>
                <Table variant="compact" aria-label="Intervalle und Cronjobs">
                  <Thead>
                    <Tr>
                      <Th>Aktiv</Th>
                      <Th>Name</Th>
                      <Th>Anzahl</Th>
                      <Th>Cron-Syntax</Th>
                      <Th></Th>
                      <Th></Th>
                      <Th></Th>
                    </Tr>
                  </Thead>
                  <Tbody>
                    {intervalRows.map((row) => (
                      <Tr key={row.id}>
                        <Td>
                          <Switch
                            id={`interval-active-${row.id}`}
                            isChecked={row.active}
                            onChange={checked => handleIntervalRow(row.id, "active", checked)}
                            aria-label="Aktiv"
                          />
                        </Td>
                        <Td>
                          <TextInput
                            value={row.name}
                            onChange={(_, v) => handleIntervalRow(row.id, "name", v)}
                            aria-label="Name"
                          />
                        </Td>
                        <Td>
                          <TextInput
                            value={row.count}
                            onChange={(_, v) => handleIntervalRow(row.id, "count", v)}
                            aria-label="Anzahl"
                            validated={countErrors[row.id] ? "error" : "default"}
                          />
                          {countErrors[row.id] && (
                            <FormHelperText className="pf-m-error" style={{color: "#c9190b"}}>
                              {countErrors[row.id]}
                            </FormHelperText>
                          )}
                        </Td>
                        <Td>
                          <Tooltip content={cronErrors[row.id] ? cronTooltip : undefined}>
                            <TextInput
                              value={row.cronSyntax}
                              onChange={(_, v) => handleIntervalRow(row.id, "cronSyntax", v)}
                              aria-label="Cron-Syntax"
                              validated={cronErrors[row.id] ? "error" : "default"}
                            />
                          </Tooltip>
                          {cronPreview[row.id] && (
                            <div style={{fontSize: "0.9em", color: "#555", marginTop: 4}}>{cronPreview[row.id]}</div>
                          )}
                        </Td>
                        <Td>
                          <Tooltip
                            content={playButtonStates[row.id]?.enabled
                              ? "Backup für dieses Intervall starten"
                              : playButtonStates[row.id]?.reason || "Dieses Intervall ist nicht korrekt gespeichert"}
                          >
                            <span>
                              <Button
                                variant="plain"
                                aria-label="Backup starten"
                                isDisabled={!playButtonStates[row.id]?.enabled || !rsnapshotAvailable || !sudoAvailable}
                                onClick={() => {
                                  setOutput(prev => prev + `Starte rsnapshot-Backup (${row.name})...\n`);
                                  cockpit.spawn(["rsnapshot", row.name], { superuser: "require", err: "message" })
                                    .stream(data => setOutput(prev => prev + data))
                                    .then(() => {
                                      setOutput(prev => prev + "\nBackup abgeschlossen.\n");
                                      setAlerts(alerts => [
                                        ...alerts,
                                        { title: `Backup gestartet (${row.name})`, variant: "success" },
                                        { title: `Backup abgeschlossen (${row.name})`, variant: "success" }
                                      ]);
                                    })

                                    .catch(error => {
                                      setOutput(prev =>
                                        prev +
                                        "Fehler beim Backup: " +
                                        (error?.message || "") +
                                        (error?.problem ? "\n" + error.problem : "") +
                                        (error?.stderr ? "\n" + error.stderr : "") +
                                        "\n"
                                      );
                                      setAlerts(alerts => [...alerts, { title: `Fehler beim Backup (${row.name}) – Details siehe Log unten`, variant: "danger" }]);
                                    });
                                }}
                              >
                                <PlayIcon />
                              </Button>
                            </span>
                          </Tooltip>
                        </Td>
                        <Td>
                          <Tooltip
                            content={
                              playButtonStates[row.id]?.enabled
                                ? "Testlauf (dry-run): Zeigt, was rsnapshot für dieses Intervall tun würde (rsnapshot -t " + row.name + ")"
                                : "Dryrun ist nur möglich, wenn das Intervall exakt gespeichert ist."
                            }
                          >
                            <span>
                              <Button
                                variant="plain"
                                aria-label="Dryrun"
                                isDisabled={!playButtonStates[row.id]?.enabled || !rsnapshotAvailable || !sudoAvailable}
                                onClick={() => {
                                  setOutput(prev => prev + `Starte Testlauf (dry-run) für rsnapshot ${row.name}...\n`);
                                  cockpit.spawn(["rsnapshot", "-t", row.name], { superuser: "require", err: "message" })
                                    .stream(data => setOutput(prev => prev + data))
                                    .then(() => {
                                      setOutput(prev => prev + "\nTestlauf abgeschlossen.\n");
                                      setAlerts(alerts => [...alerts, { title: `Testlauf erfolgreich (${row.name})`, variant: "success" }]);
                                    })
                                    .catch(error => {
                                      setOutput(prev =>
                                        prev +
                                        "Fehler beim Testlauf: " +
                                        (error?.message || "") +
                                        (error?.problem ? "\n" + error.problem : "") +
                                        (error?.stderr ? "\n" + error.stderr : "") +
                                        "\n"
                                      );
                                      setAlerts(alerts => [...alerts, { title: `Fehler beim Testlauf (${row.name}) – Details siehe Log unten`, variant: "danger" }]);
                                    });
                                }}
                              >
                                <PlayCircleIcon />
                              </Button>
                            </span>
                          </Tooltip>
                        </Td>
                        <Td>
                          <Button variant="plain" aria-label="Intervall entfernen" isDisabled={intervalRows.length <= 1}
                            onClick={() => removeInterval(row.id)}><MinusCircleIcon /></Button>
                        </Td>
                      </Tr>
                    ))}
                  </Tbody>
                </Table>
                <Button variant="link" icon={<PlusIcon />} onClick={addInterval}>Intervall hinzufügen</Button>
              </FormGroup>
              <FormGroup label="Backup-Jobs" fieldId="backups">
                <FormHelperText>
                  Definiert, welche Verzeichnisse gesichert werden. <br />
                  <b>Quelle</b>: Das Quellverzeichnis (z.B. <code>/home/</code>)<br />
                  <b>Ziel</b>: Das Ziel (meist <code>localhost/</code> oder ein anderer Host)<br />
                  <b>Optionen</b>: Zusätzliche rsync-Optionen (optional)
                </FormHelperText>
                <Table variant="compact" aria-label="Backup-Jobs">
                  <Thead>
                    <Tr>
                      <Th>
                        <Tooltip content="Das Quellverzeichnis, das gesichert werden soll."/>
                        Quelle
                      </Th>
                      <Th>
                        <Tooltip content="Das Ziel (meist 'localhost/' oder ein anderer Host)."/>
                        Ziel
                      </Th>
                      <Th>
                        <Tooltip content="Optionale rsync-Optionen, z.B. --exclude oder --link-dest."/>
                        Optionen
                      </Th>
                      <Th></Th>
                    </Tr>
                  </Thead>
                  <Tbody>
                    {backups.map((b, idx) => (
                      <Tr key={idx}>
                        <Td>
                          <TextInput value={b.source} onChange={(_, v) => handleBackup(idx, "source", v)} placeholder="z.B. /home/" />
                        </Td>
                        <Td>
                          <TextInput value={b.dest} onChange={(_, v) => handleBackup(idx, "dest", v)} placeholder="z.B. localhost/" />
                        </Td>
                        <Td>
                          <TextInput value={b.options} onChange={(_, v) => handleBackup(idx, "options", v)} placeholder="z.B. --exclude=tmp/" />
                        </Td>
                        <Td>
                          <Button variant="plain" aria-label="Backup entfernen" onClick={() => removeBackup(idx)}>✕</Button>
                        </Td>
                      </Tr>
                    ))}
                  </Tbody>
                </Table>
                <Button variant="link" onClick={addBackup}>Backup hinzufügen</Button>
              </FormGroup>

              <FormGroup label="Ausschlüsse (exclude/exclude_file)" fieldId="excludes">
                <FormHelperText>
                  Dateien/Verzeichnisse, die vom Backup ausgeschlossen werden sollen.
                </FormHelperText>
                {excludes.map((e, idx) => (
                  <div key={idx} style={{display: "flex", alignItems: "center", marginBottom: 4}}>
                    <TextInput value={e} onChange={(_, v) => handleExclude(idx, v)} />
                    <Button variant="plain" aria-label="Exclude entfernen" onClick={() => removeExclude(idx)}>✕</Button>
                  </div>
                ))}
                <Button variant="link" onClick={addExclude}>Ausschluss hinzufügen</Button>
              </FormGroup>
              <FormGroup label="Weitere Optionen (Rohtext)" fieldId="rest">
                <FormHelperText>
                  Weitere Konfigurationszeilen, die nicht direkt unterstützt werden.
                </FormHelperText>
                <TextArea
                  ref={restRef}
                  value={rest.join("\n")}
                  onChange={(_, v) => setRest(v.split("\n"))}
                  style={{ minHeight: "100px", fontFamily: "monospace" }}
                  aria-label="Weitere Optionen Rohtext"
                  onKeyDown={handleRestTab}
                />
              </FormGroup>
            </Form>
          </StackItem>
          <StackItem>
            <Title headingLevel="h2" size="md" style={{marginTop: "2em"}}>Manuelle Bearbeitung</Title>
            <Stack hasGutter>
              <StackItem>
                <div className="conf-header">
                  <strong>rsnapshot.conf (Rohtext):</strong>
                  <Tooltip content="Neu laden">
                    <SyncAltIcon className="conf-reload" onClick={loadAll} />
                  </Tooltip>
                  <Tooltip content="Speichern">
                    <Button
                      variant="plain"
                      aria-label="rsnapshot.conf speichern"
                      onClick={saveRawConf}
                      isDisabled={isSavingRawConf}
                      style={{marginLeft: "0.2em"}}
                    >
                      {isSavingRawConf ? <Spinner size="sm" /> : <SaveIcon />}
                    </Button>
                  </Tooltip>
                </div>
                <TextArea
                  ref={rawConfRef}
                  value={rawConf}
                  onChange={(_, v) => setRawConf(v)}
                  style={{ minHeight: "200px", fontFamily: "monospace" }}
                  aria-label="rsnapshot.conf Rohtext"
                  onKeyDown={e => {
                    if (e.key === "Tab") {
                      e.preventDefault();
                      const target = e.target as HTMLTextAreaElement;
                      const start = target.selectionStart;
                      const end = target.selectionEnd;
                      setRawConf(
                        rawConf.substring(0, start) + "\t" + rawConf.substring(end)
                      );
                      setTimeout(() => {
                        if (rawConfRef.current) {
                          rawConfRef.current.selectionStart = rawConfRef.current.selectionEnd = start + 1;
                        }
                      }, 0);
                    }
                  }}
                />
              </StackItem>
              <StackItem>
                <div className="conf-header">
                  <strong>/etc/cron.d/rsnapshot (Rohtext):</strong>
                  <Tooltip content="Neu laden">
                    <SyncAltIcon className="conf-reload" onClick={loadAll} />
                  </Tooltip>
                  <Tooltip content="Speichern">
                    <Button
                      variant="plain"
                      aria-label="cron.d speichern"
                      onClick={saveRawCron}
                      isDisabled={isSavingRawCron}
                      style={{marginLeft: "0.2em"}}
                    >
                      {isSavingRawCron ? <Spinner size="sm" /> : <SaveIcon />}
                    </Button>
                  </Tooltip>
                </div>
                <TextArea
                  value={rawCron}
                  onChange={(_, v) => setRawCron(v)}
                  style={{ minHeight: "150px", fontFamily: "monospace" }}
                  aria-label="cron.d/rsnapshot Rohtext"
                />
              </StackItem>
            </Stack>
            {manualConfWarn.length > 0 && (
              <Alert
                title="Achtung: Cronjobs und rsnapshot-Konfiguration passen nicht zusammen"
                variant="warning"
                isInline
                style={{marginTop: "1em"}}
                isPlain
              >
                <ul>
                  {manualConfWarn.map((w, i) => (
                    <li key={i} dangerouslySetInnerHTML={{__html: w}} />
                  ))}
                </ul>
              </Alert>
            )}
          </StackItem>
          <StackItem>
            <strong>Ausgabe / Log:</strong>
            <pre style={{padding: "1em", border: "1px solid #ccc", minHeight: "100px"}}>{output}</pre>
          </StackItem>
        </Stack>
      </PageSection>
    </Page>
  );
};

export default App;
