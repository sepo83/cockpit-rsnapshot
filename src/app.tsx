import '@patternfly/react-core/dist/styles/base.css';
import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { ExpandableSection } from "@patternfly/react-core";
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
    rest: [] as string[],
    rawLines: lines
  };
  const intervalMap: Record<string, IntervalRow> = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Check if the line is commented out
    // Entferne ggf. das führende "#" für die weitere Analyse
    const isCommented = trimmed.startsWith("#");
    const cleanLine = isCommented ? trimmed.slice(1).trim() : trimmed;

    if (cleanLine.startsWith("snapshot_root")) {
      result.snapshot_root = cleanLine.split(/\s+/)[1] || "";
    } else if (cleanLine.startsWith("logfile")) {
      result.logfile = cleanLine.split(/\s+/)[1] || "";
    } else if (cleanLine.startsWith("verbose")) {
      result.verbose = cleanLine.split(/\s+/)[1] || "";
    } else if (/^(retain|interval)\s+/.test(cleanLine)) {
      const [, name, count] = cleanLine.split(/\s+/);
      if (name) {
        intervalMap[name] = {
          id: newId(),
          name,
          count,
          cronSyntax: "",
          active: !isCommented
        };
      }
    } else if (cleanLine.startsWith("backup")) {
      const [, source, dest, ...opts] = cleanLine.split(/\s+/);
      result.backups.push({ source, dest, options: opts.join(" ") });
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
    const trimmed = line.trim();
    if (!trimmed) return;
    // Check if the line is commented out
    const isCommented = trimmed.startsWith("#");
    const cleanLine = isCommented ? trimmed.slice(1).trim() : trimmed;
    const cleanLine = isCommented ? trimmed.slice(1).trim() : trimmed;

    intervals.forEach(interval => {
      if (cleanLine.includes(`rsnapshot ${interval.name}`)) {
        cronMap[interval.name] = {
          cronSyntax: cleanLine.split(/\s+root/)[0].trim(),
          active: !isCommented
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
    if (!cronExpr) return "Next run will be executed at system start";
    const interval = CronExpressionParser.parse(cronExpr, {
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone
    });
    const next = interval.next();
    return `Next run: ${next.toDate().toLocaleString()}`;
  } catch (e) {
    return "Error: " + e;
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
  const [rest, setRest] = useState<string[]>([]);

  const [rawConf, setRawConf] = useState("");
  const [rawCron, setRawCron] = useState("");
  const [isSavingRawConf, setIsSavingRawConf] = useState(false);
  const [isSavingRawCron, setIsSavingRawCron] = useState(false);

  const [manualConfWarn, setManualConfWarn] = useState<string[]>([]);
  const [lastBackupInfo, setLastBackupInfo] = useState<string>("");

  const [cronPreview, setCronPreview] = useState<{[key: string]: string}>({});

  // Refs for Tabulator-Workaround
  const rawConfRef = useRef<HTMLTextAreaElement>(null);
  const restRef = useRef<HTMLTextAreaElement>(null);

  // check Snapshot Root
  const checkSnapshotRoot = useCallback((dir: string) => {
    if (!dir || dir.trim() === "") {
      setSnapshotRootStatus("empty");
      setSnapshotRootStatusMsg("Please specify");
      return;
    }
    cockpit.spawn([ "bash", "-c", `[ -d "${dir.replace(/"/g, '\\"')}" ] && [ -w "${dir.replace(/"/g, '\\"')}" ] && echo OK || ( [ -d "${dir.replace(/"/g, '\\"')}" ] && echo NOWRITE || echo NOEXIST )` ])
      .then((out: string) => {
        if (out.trim() === "OK") {
          setSnapshotRootStatus("ok");
          setSnapshotRootStatusMsg("Directory exists and is writable.");
        } else if (out.trim() === "NOWRITE") {
          setSnapshotRootStatus("notwritable");
          setSnapshotRootStatusMsg("Directory exists, but is not writable! rsnapshot will create the directory (exception: no_create_root 1).");
        } else {
          setSnapshotRootStatus("notfound");
          setSnapshotRootStatusMsg("Directory does not exist! rsnapshot will create the directory (exception: no_create_root 1).");
        }
      })
      .catch((err: any) => {
        setSnapshotRootStatus("error");
        setSnapshotRootStatusMsg("Error during check: " + (err?.message || err));
      });
  }, []);

  useEffect(() => {
    checkSnapshotRoot(snapshotRoot);
  }, [snapshotRoot, checkSnapshotRoot]);

  // execute Configtest 
  const runConfigTest = useCallback(() => {
    setOutput(prev => prev + "Start rsnapshot configtest...\n");
    cockpit.spawn(["rsnapshot", "configtest"], { superuser: "require", err: "message" })
      .then(data => {
        setOutput(prev => prev + data + "\n");
        setAlerts(alerts => [...alerts, { title: "Configtest sucessful", variant: "success" }]);
      })
      .catch(error => {
        setOutput(prev =>
          prev +
          "Error during rsnapshot configtest: " +
          (error?.message || "") +
          (error?.problem ? "\n" + error.problem : "") +
          (error?.stderr ? "\n" + error.stderr : "") +
          "\n"
        );
        setAlerts(alerts => [...alerts, { title: "Error during rsnapshot configtest – Details see log below", variant: "danger" }]);
      });
  }, []);

  // Load and Merge
  const loadAll = useCallback(() => {
    Promise.all([
      cockpit.spawn(["cat", CONF_PATH]),
      cockpit.spawn(["cat", CRON_PATH]).catch(() => "")
    ]).then(([confData, cronData]) => {
      setRawConf(confData);
      setRawCron(cronData);

      // parse config 
      const parsedConfig = parseConfig(confData);
      setSnapshotRoot(parsedConfig.snapshot_root);
      setLogfile(parsedConfig.logfile);
      setVerbose(parsedConfig.verbose);
      setBackups(parsedConfig.backups.filter(isValidBackupJob));
      setRest(parsedConfig.rest);

      // Merge intervals from cron
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
          setLastBackupInfo("No backup found.");
          return;
        }
        return cockpit.spawn(["stat", "-c", "%y", dir.trim()])
          .then(date => setLastBackupInfo(`${dir.trim()} (last modified: ${date.trim()})`))
          .catch(() => setLastBackupInfo(dir.trim()));
      })
      .catch(() => setLastBackupInfo("No backup found."));
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
        setAlerts(alerts => [...alerts, {title: "Configuration and cron jobs saved", variant: "success"}]);
        setSuccessFlash(true);
        loadAll();
        setTimeout(() => setSuccessFlash(false), 1000);
        runConfigTest();
      })
      .catch(error => {
        setAlerts(alerts => [
          ...alerts,
          {title: "Error saving: " + (error?.message || JSON.stringify(error)), variant: "danger"}
        ]);
      })
      .finally(() => setIsSavingConfig(false));
  }

  const saveRawConf = useCallback(() => {
    setIsSavingRawConf(true);
    cockpit.file(CONF_PATH, { superuser: "require" }).replace(rawConf)
      .then(() => {
        setAlerts(alerts => [...alerts, {title: "Configuration saved", variant: "success"}]);
        loadAll();
      })
      .catch(error => {
        setAlerts(alerts => [
          ...alerts,
          {title: "Error saving configuration: " + (error?.message || JSON.stringify(error)), variant: "danger"}
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
        setAlerts(alerts => [...alerts, {title: "Cron file saved", variant: "success"}]);
        loadAll();
      })
      .catch(error => {
        setAlerts(alerts => [
          ...alerts,
          {title: "Error saving cron file: " + (error?.message || JSON.stringify(error)), variant: "danger"}
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
          reason: "This interval is not saved as an active retain/interval in rsnapshot.conf."
        };
      } else if (!cron || !cron.active) {
        result[row.id] = {
          enabled: false,
          reason: "This interval is not saved as an active cron job in /etc/cron.d/rsnapshot."
        };
      } else if (
        retain.count !== row.count ||
        row.cronSyntax !== cron.cronSyntax ||
        !row.active
      ) {
        result[row.id] = {
          enabled: false,
          reason: "This interval is not exactly saved (Name, count, cron syntax, and active status must match)."
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
        [id]: isValidCronSyntax(value) ? undefined : "Invalid cron syntax (e.g. 0 * * * * or @daily)"
      }));
    }
    if (field === "count") {
      setCountErrors(errors => ({
        ...errors,
        [id]: isValidCount(value) || value === "" ? undefined : "Only positive integers are allowed"
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
        <Title headingLevel="h1" size="lg">rsnapshot Management</Title>
        <div style={{marginBottom: 8, color: "#555", fontSize: "1em"}}>
          <strong>rsnapshot</strong> is a flexible backup tool based on rsync and hardlinks.<br />
          This Cockpit plugin enables the simple management of the most important settings, cron jobs, and backups.<br />
          <a href="https://rsnapshot.org/" target="_blank" rel="noopener noreferrer">Project page</a>
        </div>
        <AlertGroup isToast>
          {alerts.map((alert, idx) => (
            <Alert key={idx} title={alert.title} variant={alert.variant} timeout={5000} />
          ))}
        </AlertGroup>
        {rsnapshotAvailable === false && (
          <Alert title="rsnapshot is not installed" variant="danger" isInline>
            The program <strong>rsnapshot</strong> is not installed on this system.<br />
            Install it for example with:<br />
            <code>sudo apt install rsnapshot</code> (Debian/Ubuntu)<br />
            <code>sudo dnf install rsnapshot</code> (Fedora/RedHat)<br />
            <code>sudo zypper install rsnapshot</code> (openSUSE)
          </Alert>
        )}
        {sudoAvailable === false && (
          <Alert title="No sudo rights" variant="danger" isInline>
            You have no sudo rights or your Cockpit session user is not allowed to modify system files.<br />
            Please run Cockpit as an administrator.
          </Alert>
        )}
        <Stack hasGutter>
          <StackItem>
            <div className={`conf-header${successFlash ? " success-flash" : ""}`} style={{alignItems: "center"}}>
              <strong>rsnapshot configuration:</strong>
              <Tooltip content="Load configuration">
                <Button
                  variant="plain"
                  aria-label="Load configuration"
                  onClick={loadAll}
                  style={{marginLeft: "0.2em"}}
                >
                  <SyncAltIcon />
                </Button>
              </Tooltip>
              <Tooltip content="Save configuration">
                <Button
                  variant="plain"
                  aria-label="Save configuration"
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
              <Tooltip content="Test configuration (rsnapshot configtest)">
                <Button
                  variant="plain"
                  aria-label="Test configuration"
                  onClick={runConfigTest}
                  isDisabled={!rsnapshotAvailable || !sudoAvailable}
                  style={{marginLeft: "0.2em"}}
                >
                  <CheckIcon />
                </Button>
              </Tooltip>
              {successFlash && <Badge style={{marginLeft: 8}} isRead>Saved</Badge>}
            </div>
            <Form>
              <FormGroup label="Snapshot Root" fieldId="snapshot_root">
                <FormHelperText>
                  Directory where backups are stored. Must be a local path (no remote path, but for example a mounted NFS volume is possible).
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

              <FormGroup label="Intervals & Cron jobs" fieldId="intervals">
                <FormHelperText>
                  Defines how many snapshots are kept per interval and when they run. You can add or remove intervals.
                </FormHelperText>
                <Table variant="compact" aria-label="Intervals and Cron jobs">
                  <Thead>
                    <Tr>
                      <Th>
                        <Tooltip content="Name of the interval, e.g. hourly, daily, weekly, monthly.">
                          <span>Name</span>
                        </Tooltip>
                      </Th>
                      <Th>
                        <Tooltip content="How many backups of this interval should be kept?">
                          <span>Count</span>
                        </Tooltip>
                      </Th>
                      <Th>
                        <Tooltip content={
                          <span>
                            When should the interval run? <br />
                            Cron syntax, e.g. <code>0 * * * *</code> (every hour), <code>30 3 * * *</code> (daily at 3:30 AM), <code>@daily</code>
                          </span>
                        }>
                          <span>Cron syntax</span>
                        </Tooltip>
                      </Th>
                      <Th>
                        <Tooltip content={
                          <span>
                            Actions for this interval:<br />
                            <b>Switch:</b> Active/Inactive<br />
                            <b>Play:</b> Start backup<br />
                            <b>Dry run:</b> Test run<br />
                            <b>Trash:</b> Delete interval
                          </span>
                        }>
                          <span>Actions</span>
                        </Tooltip>
                      </Th>
                    </Tr>
                  </Thead>
                  <Tbody>
                    {intervalRows.map((row) => (
                      <Tr key={row.id}>
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
                            aria-label="Count"
                            validated={countErrors[row.id] ? "error" : "default"}
                          />
                          {countErrors[row.id] && (
                            <FormHelperText className="pf-m-error" style={{color: "#c9190b"}}>
                              {countErrors[row.id]}
                            </FormHelperText>
                          )}
                        </Td>
                        <Td>
                          <TextInput
                            value={row.cronSyntax}
                            onChange={(_, v) => handleIntervalRow(row.id, "cronSyntax", v)}
                            aria-label="Cron-Syntax"
                            validated={cronErrors[row.id] ? "error" : "default"}
                            placeholder='0 0 * * *'
                          />
                          {cronErrors[row.id] ? (
                            <FormHelperText className="pf-m-error" style={{ color: "#c9190b", marginTop: 4 }}>
                              Invalid cron syntax. See examples in tooltip
                            </FormHelperText>
                          ) : (
                            cronPreview[row.id] && (
                              <div style={{ fontSize: "0.9em", color: "#555", marginTop: 4 }}>{cronPreview[row.id]}</div>
                            )
                          )}
                        </Td>
                        <Td>
                          <Tooltip content={row.active ? "Disable interval" : "Enable interval"}>
                            <Switch
                              id={`interval-active-${row.id}`}
                              isChecked={row.active}
                              onChange={(_,checked) => handleIntervalRow(row.id, "active", checked)}
                              aria-label="Active"
                              style={{marginRight: 8, verticalAlign: "middle"}}
                            />
                          </Tooltip>
                          <Tooltip
                            content={playButtonStates[row.id]?.enabled
                              ? "Start backup for this interval"
                              : playButtonStates[row.id]?.reason || "This interval is not correctly saved"}
                          >
                            <span>
                              <Button
                                variant="plain"
                                aria-label="Start backup"
                                isDisabled={!playButtonStates[row.id]?.enabled || !rsnapshotAvailable || !sudoAvailable}
                                onClick={() => {
                                  setOutput(prev => prev + `Start rsnapshot backup for ${row.name}...\n`);
                                  cockpit.spawn(["rsnapshot", row.name], { superuser: "require", err: "message" })
                                    .stream(data => setOutput(prev => prev + data))
                                    .then(() => {
                                      setOutput(prev => prev + "\nBackup completed.\n");
                                      setAlerts(alerts => [
                                        ...alerts,
                                        { title: `Backup started for ${row.name}`, variant: "success" },
                                        { title: `Backup completed for ${row.name}`, variant: "success" }
                                      ]);
                                    })
                                    .catch(error => {
                                      setOutput(prev =>
                                        prev +
                                        "Error during backup: " +
                                        (error?.message || "") +
                                        (error?.problem ? "\n" + error.problem : "") +
                                        (error?.stderr ? "\n" + error.stderr : "") +
                                        "\n"
                                      );
                                      setAlerts(alerts => [...alerts, { title: `Error during backup for ${row.name} – Details see log below`, variant: "danger" }]);
                                    });
                                }}
                              >
                                <PlayIcon />
                              </Button>
                            </span>
                          </Tooltip>
                          <Tooltip
                            content={
                              playButtonStates[row.id]?.enabled
                                ? "Dry-run (test): Shows what rsnapshot would do for this interval (rsnapshot -t " + row.name + ")"
                                : "Dry-run is only possible if the interval is exactly saved."
                            }
                          >
                            <span>
                              <Button
                                variant="plain"
                                aria-label="Dry-run"
                                isDisabled={!playButtonStates[row.id]?.enabled || !rsnapshotAvailable || !sudoAvailable}
                                onClick={() => {
                                  setOutput(prev => prev + `Start dry-run for rsnapshot ${row.name}...\n`);
                                  cockpit.spawn(["rsnapshot", "-t", row.name], { superuser: "require", err: "message" })
                                    .stream(data => setOutput(prev => prev + data))
                                    .then(() => {
                                      setOutput(prev => prev + "\nDry-run completed.\n");
                                      setAlerts(alerts => [...alerts, { title: `Dry-run successful for ${row.name}`, variant: "success" }]);
                                    })
                                    .catch(error => {
                                      setOutput(prev =>
                                        prev +
                                        "Error during dry-run: " +
                                        (error?.message || "") +
                                        (error?.problem ? "\n" + error.problem : "") +
                                        (error?.stderr ? "\n" + error.stderr : "") +
                                        "\n"
                                      );
                                      setAlerts(alerts => [...alerts, { title: `Error during dry-run for ${row.name} – Details see log below`, variant: "danger" }]);
                                    });
                                }}
                              >
                                <PlayCircleIcon />
                              </Button>
                            </span>
                          </Tooltip>
                          <Tooltip content="Remove interval">
                            <span>
                              <Button
                                variant="plain"
                                aria-label="Remove interval"
                                isDisabled={intervalRows.length <= 1}
                                onClick={() => removeInterval(row.id)}
                              >
                                <MinusCircleIcon />
                              </Button>
                            </span>
                          </Tooltip>
                        </Td>
                      </Tr>
                    ))}
                  </Tbody>
                </Table>


                <Button variant="link" icon={<PlusIcon />} onClick={addInterval}>Add interval</Button>
              </FormGroup>
              <FormGroup label="Backup Jobs" fieldId="backups">
                <FormHelperText>
                  Defines which directories should be backed up.
                </FormHelperText>
                <Table variant="compact" aria-label="Backup Jobs">
                  <Thead>
                    <Tr>
                      <Th>
                        <Tooltip content="The source directory to be backed up.">
                          <span>Source</span>
                        </Tooltip>
                      </Th>
                      <Th>
                        <Tooltip content="The destination (usually 'localhost/' or another host).">
                          <span>Destination</span>
                        </Tooltip>
                      </Th>
                      <Th>
                        <Tooltip content="Optional rsync options, e.g. --exclude or --link-dest.">
                          <span>Options</span>
                        </Tooltip>
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
                          <Button variant="plain" aria-label="Remove backup" onClick={() => removeBackup(idx)}>✕</Button>
                        </Td>
                      </Tr>
                    ))}
                  </Tbody>
                </Table>
                <Button variant="link" onClick={addBackup}>Backup hinzufügen</Button>
              </FormGroup>
              <FormGroup label="Additional Options (Raw Text)" fieldId="rest">
                <FormHelperText>
                  Additional configuration lines that are not directly supported.
                </FormHelperText>
                <TextArea
                  ref={restRef}
                  value={rest.join("\n")}
                  onChange={(_, v) => setRest(v.split("\n"))}
                  style={{ minHeight: "100px", fontFamily: "monospace" }}
                  aria-label="Additional Options Raw Text"
                  onKeyDown={handleRestTab}
                />
              </FormGroup>
            </Form>
          </StackItem>
          <StackItem>
            <ExpandableSection toggleText="Manual Editing" isIndented>
              <Stack hasGutter>
                <StackItem>
                  <div className="conf-header">
                    <strong>rsnapshot.conf (Raw Text):</strong>
                    <Tooltip content="Reload">
                      <SyncAltIcon className="conf-reload" onClick={loadAll} />
                    </Tooltip>
                    <Tooltip content="Save">
                      <Button
                        variant="plain"
                        aria-label="rsnapshot.conf save"
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
                    aria-label="rsnapshot.conf Raw Text"
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
                    <strong>/etc/cron.d/rsnapshot (Raw Text):</strong>
                    <Tooltip content="Reload">
                      <SyncAltIcon className="conf-reload" onClick={loadAll} />
                    </Tooltip>
                    <Tooltip content="Save">
                      <Button
                        variant="plain"
                        aria-label="cron.d save"
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
                    aria-label="cron.d/rsnapshot Raw Text"
                  />
                </StackItem>
              </Stack>
                  
              {manualConfWarn.length > 0 && (
                <Alert
                  title="Warning: Cron jobs and rsnapshot configuration do not match"
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
            </ExpandableSection>
          </StackItem>
          <StackItem>
            <strong>Output / Log:</strong>
            <pre style={{padding: "1em", border: "1px solid #ccc", minHeight: "100px"}}>{output}</pre>
          </StackItem>
        </Stack>
      </PageSection>
    </Page>
  );
};

export default App;
