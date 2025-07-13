import '@patternfly/react-core/dist/styles/base.css';
import React, { useState, useEffect, useCallback } from "react";
import parser from "cron-parser";
import cockpit from "cockpit";
import {
  Page, PageSection, Title, Button, TextArea, Alert, AlertGroup, Stack, StackItem,
  Toolbar, ToolbarContent, ToolbarItem, Form, FormGroup, TextInput, Tooltip, Spinner, Switch, FormHelperText, Badge,
  FormSelect, FormSelectOption
} from "@patternfly/react-core";
import {
  Table, Thead, Tbody, Tr, Th, Td
} from '@patternfly/react-table';
import { SyncAltIcon, SaveIcon, SearchIcon } from '@patternfly/react-icons';
import "./app.scss";

const INTERVALS = ["hourly", "daily", "weekly", "monthly"] as const;
type IntervalName = typeof INTERVALS[number];

type IntervalRow = {
  name: IntervalName;
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

const DEFAULT_CRON: Record<IntervalName, { active: boolean; syntax: string }> = {
  hourly: { active: false, syntax: "0 * * * *" },
  daily: { active: false, syntax: "30 3 * * *" },
  weekly: { active: false, syntax: "0 3 * * 1" },
  monthly: { active: false, syntax: "30 2 1 * *" }
};

function parseConfig(conf: string) {
  const lines = conf.split("\n");
  const result: {
    snapshot_root: string;
    logfile: string;
    verbose: string;
    intervals: Partial<Record<IntervalName, string>>;
    backups: BackupJob[];
    excludes: string[];
    rest: string[];
    rawLines: string[];
  } = {
    snapshot_root: "",
    logfile: "",
    verbose: "",
    intervals: {},
    backups: [],
    excludes: [],
    rest: [],
    rawLines: lines
  };
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
      if (INTERVALS.includes(name as IntervalName)) {
        result.intervals[name as IntervalName] = count;
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
  INTERVALS.forEach(i => { if (!(i in result.intervals)) result.intervals[i] = ""; });
  return result;
}

function serializeConfig(parsed: any, intervalRows: IntervalRow[]) {
  const lines: string[] = [];
  if (parsed.snapshot_root) lines.push(`snapshot_root\t${parsed.snapshot_root}`);
  if (parsed.logfile) lines.push(`logfile\t${parsed.logfile}`);
  if (parsed.verbose) lines.push(`verbose\t${parsed.verbose}`);
  INTERVALS.forEach(i => {
    const row = intervalRows.find((r: any) => r.name === i);
    if (row && row.count && isValidCount(row.count)) {
      const line = `retain\t${i}\t${row.count}`;
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

function extractActiveRetains(conf: string): string[] {
  return conf.split("\n")
    .filter(line => line.match(/^\s*(retain|interval)\s+/) && !line.trim().startsWith("#"))
    .map(line => line.trim().split(/\s+/)[1]);
}
function extractActiveCronJobs(cron: string): string[] {
  return cron.split("\n")
    .filter(line => !line.trim().startsWith("#") && /rsnapshot\s+(hourly|daily|weekly|monthly)/.test(line))
    .map(line => {
      const m = line.match(/rsnapshot\s+(hourly|daily|weekly|monthly)/);
      return m ? m[1] : "";
    });
}

function getNextCronRun(cron: string): string {
  try {
    // Shortcuts wie @daily etc.
    const shortcutMap: Record<string, string> = {
      "@hourly": "0 * * * *",
      "@daily": "0 0 * * *",
      "@weekly": "0 0 * * 0",
      "@monthly": "0 0 1 * *",
      "@yearly": "0 0 1 1 *",
      "@annually": "0 0 1 1 *",
      "@reboot": "", // Nicht berechenbar
    };
    const cronExpr = shortcutMap[cron.trim()] || cron;
    if (!cronExpr) return "Wird beim Systemstart ausgeführt";
    const interval = parser.parseExpression(cronExpr, {
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone
    });
    const next = interval.next();
    return "Nächster Lauf: " + next.toDate().toLocaleString();
  } catch (e) {
    return "";
  }
}

function hasSudoRights(): Promise<boolean> {
  return cockpit.spawn(["sudo", "-n", "true"]).then(() => true).catch(() => false);
}

function isValidBackupJob(b: BackupJob): boolean {
  return !!b.source && !!b.dest && b.source.trim() !== "" && b.dest.trim() !== "";
}

const App: React.FC = () => {
  const [rsnapshotAvailable, setRsnapshotAvailable] = useState<boolean | null>(null);
  const [sudoAvailable, setSudoAvailable] = useState<boolean | null>(null);
  const [output, setOutput] = useState("");
  const [alerts, setAlerts] = useState<{title: string, variant: 'success'|'danger'|'warning'}[]>([]);
  const [isSavingConfig, setIsSavingConfig] = useState(false);
  const [successFlash, setSuccessFlash] = useState(false);

  const [snapshotRoot, setSnapshotRoot] = useState("");
  const [logfile, setLogfile] = useState("");
  const [verbose, setVerbose] = useState("");
  const [intervalRows, setIntervalRows] = useState<IntervalRow[]>(INTERVALS.map(i => ({
    name: i, count: "", cronSyntax: DEFAULT_CRON[i].syntax, active: false
  })));
  const [cronErrors, setCronErrors] = useState<{[key: number]: string|undefined}>({});
  const [countErrors, setCountErrors] = useState<{[key: number]: string|undefined}>({});
  const [backups, setBackups] = useState<BackupJob[]>([]);
  const [excludes, setExcludes] = useState<string[]>([]);
  const [rest, setRest] = useState<string[]>([]);

  const [rawConf, setRawConf] = useState("");
  const [rawCron, setRawCron] = useState("");
  const [isSavingRawConf, setIsSavingRawConf] = useState(false);
  const [isSavingRawCron, setIsSavingRawCron] = useState(false);

  const [manualConfWarn, setManualConfWarn] = useState<string[]>([]);
  const [lastBackupInfo, setLastBackupInfo] = useState<string>("");

  const [cronPreview, setCronPreview] = useState<{[key: number]: string}>({});

  // Backup-Intervall-Auswahl
  const [backupInterval, setBackupInterval] = useState<IntervalName>("daily");

  useEffect(() => {
    cockpit.spawn(["which", "rsnapshot"])
      .then(() => setRsnapshotAvailable(true))
      .catch(() => setRsnapshotAvailable(false));
    hasSudoRights().then(setSudoAvailable);
    loadAll();
    // eslint-disable-next-line
  }, []);

  const loadAll = useCallback(() => {
    loadConfig();
    loadCron();
    loadLastBackup();
  }, []);

  const loadConfig = useCallback(() => {
    cockpit.spawn(["cat", CONF_PATH])
      .then(data => {
        setRawConf(data);
        try {
          const parsed = parseConfig(data);
          setSnapshotRoot(parsed.snapshot_root);
          setLogfile(parsed.logfile);
          setVerbose(parsed.verbose);
          setBackups(parsed.backups.filter(isValidBackupJob));
          setExcludes(parsed.excludes.filter(e => e));
          setRest(parsed.rest);
          setIntervalRows(rows => INTERVALS.map((name, idx) => ({
            ...rows[idx],
            count: parsed.intervals[name] || ""
          })));
        } catch (err) {
          setAlerts(alerts => [
            ...alerts,
            {title: "Fehler beim Parsen der Konfiguration: " + (err as any)?.message, variant: "danger"}
          ]);
        }
      })
      .catch(error => {
        setAlerts(alerts => [
          ...alerts,
          {title: "Fehler beim Laden der Konfiguration: " + (error?.message || JSON.stringify(error)), variant: "danger"}
        ]);
      });
  }, []);

  const loadCron = useCallback(() => {
    cockpit.spawn(["cat", CRON_PATH])
      .then(data => {
        setRawCron(data);
        const cronData: any = {};
        INTERVALS.forEach(i => cronData[i] = { ...DEFAULT_CRON[i] });
        const lines = data.split("\n");
        for (const line of lines) {
          if (/^\s*#/.test(line)) continue;
          const trimmed = line.trim();
          for (const interval of INTERVALS) {
            if (trimmed.includes(`rsnapshot ${interval}`)) {
              cronData[interval].active = true;
              cronData[interval].syntax = trimmed.split(/\s+root/)[0].trim();
            }
          }
        }
        setIntervalRows(rows => INTERVALS.map((name, idx) => ({
          ...rows[idx],
          cronSyntax: cronData[name].syntax,
          active: cronData[name].active
        })));
      })
      .catch(() => {
        setRawCron("");
        setIntervalRows(rows => INTERVALS.map((name, idx) => ({
          ...rows[idx],
          cronSyntax: DEFAULT_CRON[name].syntax,
          active: false
        })));
      });
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
      })
      .catch(error => {
        setAlerts(alerts => [
          ...alerts,
          {title: "Fehler beim Speichern: " + (error?.message || JSON.stringify(error)), variant: "danger"}
        ]);
      })
      .finally(() => setIsSavingConfig(false));
  }

  const saveRawConf = () => {
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
  };

  const saveRawCron = () => {
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
  };

  useEffect(() => {
    const preview: {[key: number]: string} = {};
    intervalRows.forEach((row, idx) => {
      if (row.cronSyntax && isValidCronSyntax(row.cronSyntax)) {
        preview[idx] = getNextCronRun(row.cronSyntax);
      } else {
        preview[idx] = "";
      }
    });
    setCronPreview(preview);
    // eslint-disable-next-line
  }, [intervalRows]);

  const handleIntervalRow = useCallback((idx: number, field: string, value: any) => {
    setIntervalRows(rows =>
      rows.map((row, i) =>
        i === idx ? { ...row, [field]: value } : row
      )
    );
    if (field === "cronSyntax") {
      setCronErrors(errors => ({
        ...errors,
        [idx]: isValidCronSyntax(value) ? undefined : "Ungültige Cron-Syntax (z.B. 0 * * * * oder @daily)"
      }));
    }
    if (field === "count") {
      setCountErrors(errors => ({
        ...errors,
        [idx]: isValidCount(value) || value === "" ? undefined : "Nur positive ganze Zahl erlaubt"
      }));
    }
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

  useEffect(() => {
    const retains = extractActiveRetains(rawConf);
    const crons = extractActiveCronJobs(rawCron);
    const missingInCron = retains.filter(r => !crons.includes(r));
    const missingInRetain = crons.filter(c => !retains.includes(c));
    const warn: string[] = [];
    if (missingInCron.length)
      warn.push(`Folgende aktive <code>retain</code>-Einträge in <code>rsnapshot.conf</code> haben keinen passenden Cronjob: ${missingInCron.map(x => `<code>${x}</code>`).join(", ")}`);
    if (missingInRetain.length)
      warn.push(`Folgende aktive Cronjobs in <code>/etc/cron.d/rsnapshot</code> haben keinen passenden <code>retain</code>-Eintrag: ${missingInRetain.map(x => `<code>${x}</code>`).join(", ")}`);
    setManualConfWarn(warn);
  }, [rawConf, rawCron]);

  useEffect(() => {
    loadLastBackup();
  }, [snapshotRoot, loadLastBackup]);

  // Tooltip für Cron-Syntax
  const cronTooltip = (
    <span>
      Ungültige Cron-Syntax.<br />
      Beispiele:<br />
      <code>0 * * * *</code> (jede Stunde)<br />
      <code>30 3 * * *</code> (täglich 3:30 Uhr)<br />
      <code>@daily</code>, <code>@hourly</code>
    </span>
  );

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
        <Toolbar>
          <ToolbarContent>
            <ToolbarItem>
              <FormSelect
                value={backupInterval}
                onChange={v => setBackupInterval(v as IntervalName)}
                aria-label="Backup-Intervall auswählen"
              >
                {INTERVALS.map(i => (
                  <FormSelectOption key={i} value={i} label={i} />
                ))}
              </FormSelect>
            </ToolbarItem>
            <ToolbarItem>
              <Button variant="primary" onClick={() => {
                setOutput(`Starte rsnapshot-Backup (${backupInterval})...\n`);
                cockpit.spawn(["sudo", "rsnapshot", backupInterval])
                  .stream(data => setOutput(prev => prev + data))
                  .then(() => setOutput(prev => prev + "\nBackup abgeschlossen.\n"))
                  .catch(error => setOutput(prev => prev + "\nFehler beim Backup: " + (error?.message || JSON.stringify(error)) + "\n"));
              }} isDisabled={!rsnapshotAvailable || !sudoAvailable}>Backup starten</Button>
            </ToolbarItem>
            <ToolbarItem>
              <Button variant="secondary" onClick={() => {
                setOutput("Lade Logdatei...\n");
                cockpit.spawn(["test", "-f", "/var/log/rsnapshot.log"])
                  .then(() => {
                    cockpit.spawn(["tail", "-n", "100", "/var/log/rsnapshot.log"])
                      .then(data => setOutput(data))
                      .catch(error => setOutput("Fehler beim Laden der Logdatei: " + (error?.message || JSON.stringify(error)) + "\n"));
                  })
                  .catch(() => setOutput("Das Logfile /var/log/rsnapshot.log existiert nicht.\nBitte prüfen Sie, ob Logging in /etc/rsnapshot.conf aktiviert ist (logfile /var/log/rsnapshot.log)."));
              }} isDisabled={!rsnapshotAvailable}>Log anzeigen</Button>
            </ToolbarItem>
          </ToolbarContent>
        </Toolbar>
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
              {successFlash && <Badge style={{marginLeft: 8}} isRead>Gespeichert</Badge>}
            </div>
            <Form>
              <FormGroup label="Backup-Ziel (snapshot_root)" fieldId="snapshot_root">
                <div style={{display: "flex", alignItems: "center", gap: 8}}>
                  <TextInput
                    id="snapshot_root"
                    value={snapshotRoot}
                    onChange={(_, v) => setSnapshotRoot(v)}
                  />
                  <Tooltip content="Verzeichnis im Terminal anzeigen">
                    <Button variant="plain" aria-label="Öffnen"
                      onClick={() => {
                        cockpit.spawn(["xdg-open", snapshotRoot])
                          .catch(() => setAlerts(alerts => [
                            ...alerts,
                            { title: "Konnte Verzeichnis nicht öffnen (kein grafisches System?)", variant: "warning" }
                          ]));
                      }}>
                      <SearchIcon />
                    </Button>
                  </Tooltip>
                </div>
                {lastBackupInfo && (
                  <div style={{fontSize: "0.95em", color: "#555", marginTop: 4}}>
                    Letztes Backup: {lastBackupInfo}
                  </div>
                )}
                <FormHelperText>
                  Verzeichnis, in dem die Snapshots gespeichert werden.
                </FormHelperText>
              </FormGroup>
              <FormGroup label="Logdatei" fieldId="logfile">
                <TextInput
                  id="logfile"
                  value={logfile}
                  onChange={(_, v) => setLogfile(v)}
                />
                <FormHelperText>
                  Pfad zur Logdatei (z.B. /var/log/rsnapshot.log)
                </FormHelperText>
              </FormGroup>
              <FormGroup label="Verbositätslevel" fieldId="verbose">
                <TextInput
                  id="verbose"
                  value={verbose}
                  onChange={(_, v) => setVerbose(v)}
                />
                <FormHelperText>
                  0=keine Ausgabe, 1=Standard, 2=mehr, 3=Debug
                </FormHelperText>
              </FormGroup>
              <FormGroup label="Intervalle & Cronjobs" fieldId="intervals">
                <FormHelperText>
                  Definiert, wie viele Snapshots pro Intervall gehalten werden und wann sie laufen.
                </FormHelperText>
                <Table variant="compact" aria-label="Intervalle und Cronjobs">
                  <Thead>
                    <Tr>
                      <Th>Aktiv</Th>
                      <Th>Name</Th>
                      <Th>Anzahl</Th>
                      <Th>Cron-Syntax</Th>
                    </Tr>
                  </Thead>
                  <Tbody>
                    {intervalRows.map((row, idx) => (
                      <Tr key={row.name}>
                        <Td>
                          <Switch
                            id={`interval-active-${row.name}`}
                            isChecked={row.active}
                            onChange={checked => handleIntervalRow(idx, "active", checked)}
                            aria-label="Aktiv"
                          />
                        </Td>
                        <Td>
                          <TextInput
                            value={row.name}
                            readOnly
                            aria-label="Name"
                          />
                        </Td>
                        <Td>
                          <TextInput
                            value={row.count}
                            onChange={(_, v) => handleIntervalRow(idx, "count", v)}
                            aria-label="Anzahl"
                            validated={countErrors[idx] ? "error" : "default"}
                          />
                          {countErrors[idx] && (
                            <FormHelperText className="pf-m-error" style={{color: "#c9190b"}}>
                              {countErrors[idx]}
                            </FormHelperText>
                          )}
                        </Td>
                        <Td>
                          <Tooltip content={cronErrors[idx] ? cronTooltip : undefined}>
                            <TextInput
                              value={row.cronSyntax}
                              onChange={(_, v) => handleIntervalRow(idx, "cronSyntax", v)}
                              aria-label="Cron-Syntax"
                              validated={cronErrors[idx] ? "error" : "default"}
                            />
                          </Tooltip>
                          {cronPreview[idx] && (
                            <div style={{fontSize: "0.9em", color: "#555", marginTop: 4}}>{cronPreview[idx]}</div>
                          )}
                        </Td>
                      </Tr>
                    ))}
                  </Tbody>
                </Table>
              </FormGroup>
              <FormGroup label="Backup-Jobs" fieldId="backups">
                <FormHelperText>
                  Definiert, welche Verzeichnisse gesichert werden.
                </FormHelperText>
                {backups.map((b, idx) => (
                  <div key={idx} style={{display: "flex", gap: 8, marginBottom: 4}}>
                    <TextInput value={b.source} onChange={(_, v) => handleBackup(idx, "source", v)} placeholder="Quelle" />
                    <TextInput value={b.dest} onChange={(_, v) => handleBackup(idx, "dest", v)} placeholder="Ziel" />
                    <TextInput value={b.options} onChange={(_, v) => handleBackup(idx, "options", v)} placeholder="Optionen" />
                    <Button variant="plain" aria-label="Backup entfernen" onClick={() => removeBackup(idx)}>✕</Button>
                  </div>
                ))}
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
                  value={rest.join("\n")}
                  onChange={(_, v) => setRest(v.split("\n"))}
                  style={{ minHeight: "100px", fontFamily: "monospace" }}
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
                    <SyncAltIcon className="conf-reload" onClick={loadConfig} />
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
                  value={rawConf}
                  onChange={(_, v) => setRawConf(v)}
                  style={{ minHeight: "200px", fontFamily: "monospace" }}
                  aria-label="rsnapshot.conf Rohtext"
                />
              </StackItem>
              <StackItem>
                <div className="conf-header">
                  <strong>/etc/cron.d/rsnapshot (Rohtext):</strong>
                  <Tooltip content="Neu laden">
                    <SyncAltIcon className="conf-reload" onClick={loadCron} />
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
