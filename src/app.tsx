import '@patternfly/react-core/dist/styles/base.css';
import React, { useState, useEffect } from "react";
import cockpit from "cockpit";
import {
  Page, PageSection, Title, Button, TextArea, Alert, AlertGroup, Stack, StackItem,
  Toolbar, ToolbarContent, ToolbarItem, Form, FormGroup, Switch, TextInput, FormHelperText,
  Tooltip, Spinner
} from "@patternfly/react-core";
import {
  Table, Thead, Tbody, Tr, Th, Td
} from '@patternfly/react-table';
import { SyncAltIcon, InfoCircleIcon, SaveIcon, PlusCircleIcon, MinusCircleIcon } from '@patternfly/react-icons';
import "./app.scss";

// --- Hilfsfunktionen zum Parsen/Serialisieren der Konfiguration ---

function parseConfig(conf: string) {
  const lines = conf.split("\n");
  const result: any = {
    snapshot_root: "",
    logfile: "",
    verbose: "",
    intervals: [],
    backups: [],
    excludes: [],
    rest: []
  };
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("snapshot_root")) result.snapshot_root = trimmed.split(/\s+/)[1] || "";
    else if (trimmed.startsWith("logfile")) result.logfile = trimmed.split(/\s+/)[1] || "";
    else if (trimmed.startsWith("verbose")) result.verbose = trimmed.split(/\s+/)[1] || "";
    else if (/^(retain|interval)\s+/.test(trimmed)) {
      const [, name, count] = trimmed.split(/\s+/);
      result.intervals.push({ name, count });
    } else if (trimmed.startsWith("backup")) {
      // backup  <source>  <dest>  [options]
      const [, source, dest, ...opts] = trimmed.split(/\s+/);
      result.backups.push({ source, dest, options: opts.join(" ") });
    } else if (trimmed.startsWith("exclude")) {
      result.excludes.push(trimmed.replace(/^exclude\s+/, ""));
    } else if (trimmed.startsWith("exclude_file")) {
      result.excludes.push("file:" + trimmed.replace(/^exclude_file\s+/, ""));
    } else if (trimmed && !trimmed.startsWith("#")) {
      result.rest.push(line);
    }
  }
  return result;
}

function serializeConfig(parsed: any) {
  let lines: string[] = [];
  if (parsed.snapshot_root) lines.push(`snapshot_root\t${parsed.snapshot_root}`);
  if (parsed.logfile) lines.push(`logfile\t${parsed.logfile}`);
  if (parsed.verbose) lines.push(`verbose\t${parsed.verbose}`);
  parsed.intervals.forEach((i: any) => lines.push(`retain\t${i.name}\t${i.count}`));
  parsed.backups.forEach((b: any) => lines.push(`backup\t${b.source}\t${b.dest}\t${b.options}`));
  parsed.excludes.forEach((e: string) =>
    e.startsWith("file:") ? lines.push(`exclude_file\t${e.slice(5)}`) : lines.push(`exclude\t${e}`)
  );
  if (parsed.rest.length) lines = lines.concat(parsed.rest);
  return lines.join("\n");
}

// --- Hauptkomponente ---

const CRON_PATH = "/etc/cron.d/rsnapshot";
const CONF_PATH = "/etc/rsnapshot.conf";

const App: React.FC = () => {
  const [rsnapshotAvailable, setRsnapshotAvailable] = useState<boolean | null>(null);
  const [output, setOutput] = useState("");
  const [config, setConfig] = useState("");
  const [configLoaded, setConfigLoaded] = useState(false);
  const [alerts, setAlerts] = useState<{title: string, variant: 'success'|'danger'|'warning'}[]>([]);
  const [isSavingConfig, setIsSavingConfig] = useState(false);

  // Cron
  const [cronSettings, setCronSettings] = useState<any>({
    hourly: false, daily: false, weekly: false, monthly: false,
    hourlyTime: "0 * * * *", dailyTime: "30 3 * * *", weeklyTime: "0 3 * * 1", monthlyTime: "30 2 1 * *"
  });
  const [cronLoaded, setCronLoaded] = useState(false);
  const [isSavingCron, setIsSavingCron] = useState(false);

  // Fehlerstatus für Cron-Zeitfelder
  const [cronErrors, setCronErrors] = useState<any>({});
  // Für die Prüfung: Sind alle aktivierten Cronjobs auch in der Konfiguration vorhanden?
  const [confIntervals, setConfIntervals] = useState<string[]>([]);
  const [cronConfMismatch, setCronConfMismatch] = useState<string[]>([]);
  // Raw-Editing für /etc/cron.d/rsnapshot
  const [cronRawContent, setCronRawContent] = useState<string>("");
  const [cronRawLoaded, setCronRawLoaded] = useState(false);
  const [isSavingCronRaw, setIsSavingCronRaw] = useState(false);

  // --- rsnapshot.conf als strukturierte Felder
  const [confParsed, setConfParsed] = useState<any>(parseConfig(config));

  // --- Manuelle Bearbeitung (Rohtext) für beide Dateien
  const [rawConf, setRawConf] = useState(config);
  const [rawCron, setRawCron] = useState(cronRawContent);
  const [isSavingRawConf, setIsSavingRawConf] = useState(false);

  // === Initial-Laden ===
  useEffect(() => {
    cockpit.spawn(["which", "rsnapshot"])
      .then(() => setRsnapshotAvailable(true))
      .catch(() => setRsnapshotAvailable(false));
    loadCron();
    loadConfig();
    // eslint-disable-next-line
  }, []);

  // Wenn config von außen kommt, neu parsen
  useEffect(() => {
    setConfParsed(parseConfig(config));
    setRawConf(config);
  }, [config]);

  // Wenn confParsed geändert wird, config serialisieren und melden
  useEffect(() => {
    setConfig(serializeConfig(confParsed));
    setConfIntervals(confParsed.intervals.map((i: any) => i.name));
    // eslint-disable-next-line
  }, [confParsed]);

  // Wenn cronRawContent von außen kommt, aktualisiere rawCron
  useEffect(() => {
    setRawCron(cronRawContent);
  }, [cronRawContent]);

  // Prüfung, ob Cronjobs und Konfiguration zusammenpassen
  useEffect(() => {
    checkCronConfigMatch();
    // eslint-disable-next-line
  }, [cronSettings, confIntervals]);

  // === Funktionen ===

  const runBackup = () => {
    if (!rsnapshotAvailable) return;
    setOutput("Starte rsnapshot-Backup...\n");
    cockpit.spawn(["sudo", "rsnapshot", "daily"])
      .stream(data => setOutput(prev => prev + data))
      .then(() => {
        setOutput(prev => prev + "\nBackup abgeschlossen.\n");
        setAlerts(alerts => [...alerts, {title: "Backup abgeschlossen", variant: "success"}]);
      })
      .catch(error => {
        setOutput(prev => prev + "\nFehler beim Backup: " + (error?.message || JSON.stringify(error)) + "\n");
        setAlerts(alerts => [...alerts, {title: "Fehler beim Backup: " + (error?.message || JSON.stringify(error)), variant: "danger"}]);
      });
  };

  const loadConfig = () => {
    if (!rsnapshotAvailable) return;
    setOutput("Lade Konfiguration...\n");
    cockpit.spawn(["cat", CONF_PATH])
      .then(data => {
        setConfig(data);
        setConfigLoaded(true);
        setOutput("Konfiguration geladen.\n");
      })
      .catch(error => {
        setOutput("Fehler beim Laden der Konfiguration: " + (error?.message || JSON.stringify(error)) + "\n");
        setAlerts(alerts => [
          ...alerts,
          {title: "Fehler beim Laden der Konfiguration: " + (error?.message || JSON.stringify(error)), variant: "danger"}
        ]);
      });
  };

  const saveConfig = () => {
    if (!rsnapshotAvailable) return;
    setIsSavingConfig(true);
    setOutput("Speichere Konfiguration...\n");
    cockpit.file(CONF_PATH, { superuser: "require" }).replace(config)
      .then(() => {
        setOutput("Konfiguration gespeichert.\n");
        setAlerts(alerts => [...alerts, {title: "Konfiguration gespeichert", variant: "success"}]);
        loadConfig();
      })
      .catch(error => {
        setOutput("Fehler beim Speichern der Konfiguration: " + (error?.message || JSON.stringify(error)) + "\n");
        setAlerts(alerts => [
          ...alerts,
          {title: "Fehler beim Speichern der Konfiguration: " + (error?.message || JSON.stringify(error)), variant: "danger"}
        ]);
      })
      .finally(() => setIsSavingConfig(false));
  };

  // Speichern der rohen rsnapshot.conf
  const saveRawConf = () => {
    setIsSavingRawConf(true);
    cockpit.file(CONF_PATH, { superuser: "require" }).replace(rawConf)
      .then(() => {
        setAlerts(alerts => [...alerts, {title: "Konfiguration gespeichert", variant: "success"}]);
        loadConfig();
      })
      .catch(error => {
        setAlerts(alerts => [
          ...alerts,
          {title: "Fehler beim Speichern der Konfiguration: " + (error?.message || JSON.stringify(error)), variant: "danger"}
        ]);
      })
      .finally(() => setIsSavingRawConf(false));
  };

  const showLog = () => {
    if (!rsnapshotAvailable) return;
    setOutput("Lade Logdatei...\n");
    cockpit.spawn(["test", "-f", "/var/log/rsnapshot.log"])
      .then(() => {
        cockpit.spawn(["tail", "-n", "100", "/var/log/rsnapshot.log"])
          .then(data => setOutput(data))
          .catch(error => {
            setOutput("Fehler beim Laden der Logdatei: " + (error?.message || JSON.stringify(error)) + "\n");
            setAlerts(alerts => [
              ...alerts,
              {title: "Fehler beim Laden der Logdatei: " + (error?.message || JSON.stringify(error)), variant: "danger"}
            ]);
          });
      })
      .catch(() => {
        setOutput("Das Logfile /var/log/rsnapshot.log existiert nicht.\nBitte prüfen Sie, ob Logging in /etc/rsnapshot.conf aktiviert ist (logfile /var/log/rsnapshot.log).");
        setAlerts(alerts => [...alerts, {title: "Logfile nicht gefunden", variant: "danger"}]);
      });
  };

  // --- Cronjob Verwaltung ---

  const loadCron = () => {
    cockpit.spawn(["cat", CRON_PATH])
      .then(data => {
        const settings = {
          hourly: false, daily: false, weekly: false, monthly: false,
          hourlyTime: "0 * * * *", dailyTime: "30 3 * * *", weeklyTime: "0 3 * * 1", monthlyTime: "30 2 1 * *"
        };
        const lines = data.split("\n");
        for (const line of lines) {
          if (/^\s*#/.test(line)) continue;
          const trimmed = line.trim();
          if (trimmed.includes("rsnapshot hourly")) {
            settings.hourly = true;
            settings.hourlyTime = trimmed.split(/\s+root/)[0].trim();
          }
          if (trimmed.includes("rsnapshot daily")) {
            settings.daily = true;
            settings.dailyTime = trimmed.split(/\s+root/)[0].trim();
          }
          if (trimmed.includes("rsnapshot weekly")) {
            settings.weekly = true;
            settings.weeklyTime = trimmed.split(/\s+root/)[0].trim();
          }
          if (trimmed.includes("rsnapshot monthly")) {
            settings.monthly = true;
            settings.monthlyTime = trimmed.split(/\s+root/)[0].trim();
          }
        }
        setCronSettings(settings);
        setCronLoaded(true);
        setCronRawContent(data);
        setCronRawLoaded(true);
        setCronErrors({});
      })
      .catch(() => {
        setCronSettings({
          hourly: false, daily: false, weekly: false, monthly: false,
          hourlyTime: "0 * * * *", dailyTime: "30 3 * * *", weeklyTime: "0 3 * * 1", monthlyTime: "30 2 1 * *"
        });
        setCronLoaded(true);
        setCronRawContent("");
        setCronRawLoaded(true);
        setCronErrors({});
      });
  };

  const saveCron = () => {
    setIsSavingCron(true);
    let cron = "# Managed by Cockpit rsnapshot Plugin\n";
    if (cronSettings.hourly) {
      cron += `${cronSettings.hourlyTime} root /usr/bin/rsnapshot hourly\n`;
    } else {
      cron += `#${cronSettings.hourlyTime} root /usr/bin/rsnapshot hourly\n`;
    }
    if (cronSettings.daily) {
      cron += `${cronSettings.dailyTime} root /usr/bin/rsnapshot daily\n`;
    } else {
      cron += `#${cronSettings.dailyTime} root /usr/bin/rsnapshot daily\n`;
    }
    if (cronSettings.weekly) {
      cron += `${cronSettings.weeklyTime} root /usr/bin/rsnapshot weekly\n`;
    } else {
      cron += `#${cronSettings.weeklyTime} root /usr/bin/rsnapshot weekly\n`;
    }
    if (cronSettings.monthly) {
      cron += `${cronSettings.monthlyTime} root /usr/bin/rsnapshot monthly\n`;
    } else {
      cron += `#${cronSettings.monthlyTime} root /usr/bin/rsnapshot monthly\n`;
    }

    cockpit.file(CRON_PATH, { superuser: "require" }).replace(cron)
      .then(() => {
        setAlerts(alerts => [...alerts, {title: "Cronjobs gespeichert", variant: "success"}]);
        loadCron();
      })
      .catch(error => {
        setAlerts(alerts => [
          ...alerts,
          {title: "Fehler beim Speichern der Cronjobs: " + (error?.message || JSON.stringify(error)), variant: "danger"}
        ]);
      })
      .finally(() => setIsSavingCron(false));
  };

  // Raw-Editing für /etc/cron.d/rsnapshot
  const saveCronRaw = () => {
    setIsSavingCronRaw(true);
    cockpit.file(CRON_PATH, { superuser: "require" }).replace(rawCron)
      .then(() => {
        setAlerts(alerts => [...alerts, {title: "Cron-Datei gespeichert", variant: "success"}]);
        loadCron();
      })
      .catch(error => {
        setAlerts(alerts => [
          ...alerts,
          {title: "Fehler beim Speichern der Cron-Datei: " + (error?.message || JSON.stringify(error)), variant: "danger"}
        ]);
      })
      .finally(() => setIsSavingCronRaw(false));
  };

  // Switch-Handler für Cron-Intervalle (Checkboxen)
  const handleCronSwitch = (field: string) => {
    setCronSettings((prev: any) => {
      const updated = { ...prev, [field]: !prev[field] };
      // Fehler für das Zeitfeld zurücksetzen, wenn Intervall deaktiviert wird
      if (!updated[field]) {
        let errorField: string | undefined;
        switch (field) {
          case "hourly": errorField = "hourlyTime"; break;
          case "daily": errorField = "dailyTime"; break;
          case "weekly": errorField = "weeklyTime"; break;
          case "monthly": errorField = "monthlyTime"; break;
          default: errorField = undefined;
        }
        if (errorField) {
          setCronErrors((prevErrors: any) => ({ ...prevErrors, [errorField]: undefined }));
        }
      }
      return updated;
    });
  };

  // Handler für Zeitfeld-Änderung
  const handleCronChange = (field: string, value: any) => {
    setCronSettings((prev: any) => ({ ...prev, [field]: value }));
    // Validierung nur für Zeitfelder
    if (
      field === "hourlyTime" ||
      field === "dailyTime" ||
      field === "weeklyTime" ||
      field === "monthlyTime"
    ) {
      const isValid = /^([\d\/*,\-]+)\s+([\d\/*,\-]+)\s+([\d\/*,\-]+)\s+([\d\/*,\-]+)\s+([\d\/*,\-]+)$/.test(value.trim());
      setCronErrors((prev: any) => ({
        ...prev,
        [field]: isValid ? undefined : "Ungültige Cron-Syntax (5 Felder, z.B. 0 * * * *)"
      }));
    }
  };

  const cronHasErrors = (
    (cronSettings.hourly && !!cronErrors.hourlyTime) ||
    (cronSettings.daily && !!cronErrors.dailyTime) ||
    (cronSettings.weekly && !!cronErrors.weeklyTime) ||
    (cronSettings.monthly && !!cronErrors.monthlyTime)
  );

  function checkCronConfigMatch() {
    const missing: string[] = [];
    if (cronSettings.hourly && !confIntervals.includes("hourly")) missing.push("hourly");
    if (cronSettings.daily && !confIntervals.includes("daily")) missing.push("daily");
    if (cronSettings.weekly && !confIntervals.includes("weekly")) missing.push("weekly");
    if (cronSettings.monthly && !confIntervals.includes("monthly")) missing.push("monthly");
    setCronConfMismatch(missing);
  }

  // === GUI für rsnapshot.conf ===

  // Handler für einfache Felder
  const handleField = (field: string, value: string) => {
    setConfParsed((prev: any) => ({ ...prev, [field]: value }));
  };

  // Handler für Intervalle
  const handleInterval = (idx: number, field: string, value: string) => {
    setConfParsed((prev: any) => {
      const intervals = [...prev.intervals];
      intervals[idx][field] = value;
      return { ...prev, intervals };
    });
  };

  const addInterval = () => {
    setConfParsed((prev: any) => ({
      ...prev,
      intervals: [...prev.intervals, { name: "", count: "" }]
    }));
  };
  const removeInterval = (idx: number) => {
    setConfParsed((prev: any) => {
      const intervals = [...prev.intervals];
      intervals.splice(idx, 1);
      return { ...prev, intervals };
    });
  };

  // Handler für Backup-Jobs
  const handleBackup = (idx: number, field: string, value: string) => {
    setConfParsed((prev: any) => {
      const backups = [...prev.backups];
      backups[idx][field] = value;
      return { ...prev, backups };
    });
  };
  const addBackup = () => {
    setConfParsed((prev: any) => ({
      ...prev,
      backups: [...prev.backups, { source: "", dest: "", options: "" }]
    }));
  };
  const removeBackup = (idx: number) => {
    setConfParsed((prev: any) => {
      const backups = [...prev.backups];
      backups.splice(idx, 1);
      return { ...prev, backups };
    });
  };

  // Handler für Excludes
  const handleExclude = (idx: number, value: string) => {
    setConfParsed((prev: any) => {
      const excludes = [...prev.excludes];
      excludes[idx] = value;
      return { ...prev, excludes };
    });
  };
  const addExclude = () => {
    setConfParsed((prev: any) => ({
      ...prev,
      excludes: [...prev.excludes, ""]
    }));
  };
  const removeExclude = (idx: number) => {
    setConfParsed((prev: any) => {
      const excludes = [...prev.excludes];
      excludes.splice(idx, 1);
      return { ...prev, excludes };
    });
  };

  return (
    <Page>
      <PageSection>
        <Title headingLevel="h1" size="lg">rsnapshot Verwaltung</Title>
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
        <Toolbar>
          <ToolbarContent>
            <ToolbarItem>
              <Button variant="primary" onClick={runBackup} isDisabled={!rsnapshotAvailable}>Backup starten</Button>
            </ToolbarItem>
            <ToolbarItem>
              <Button variant="secondary" onClick={showLog} isDisabled={!rsnapshotAvailable}>Log anzeigen</Button>
            </ToolbarItem>
          </ToolbarContent>
        </Toolbar>
        <Stack hasGutter>
          <StackItem>
            <div className="conf-header" style={{alignItems: "center"}}>
              <strong>rsnapshot Konfiguration:</strong>
              <Tooltip content="Konfiguration neu laden">
                <SyncAltIcon className="conf-reload" onClick={loadConfig} />
              </Tooltip>
              <Tooltip content="Konfiguration speichern">
                <Button
                  variant="plain"
                  aria-label="Konfiguration speichern"
                  onClick={saveConfig}
                  isDisabled={!configLoaded || !rsnapshotAvailable || isSavingConfig}
                  style={{marginLeft: "0.2em"}}
                >
                  {isSavingConfig ? <Spinner size="sm" /> : <SaveIcon />}
                </Button>
              </Tooltip>
            </div>
            <Form>
              <FormGroup label="Backup-Ziel (snapshot_root)" fieldId="snapshot_root">
                <TextInput
                  id="snapshot_root"
                  value={confParsed.snapshot_root}
                  onChange={(_, v) => handleField("snapshot_root", v)}
                />
              </FormGroup>
              <FormGroup label="Logdatei" fieldId="logfile">
                <TextInput
                  id="logfile"
                  value={confParsed.logfile}
                  onChange={(_, v) => handleField("logfile", v)}
                />
              </FormGroup>
              <FormGroup label="Verbositätslevel" fieldId="verbose">
                <TextInput
                  id="verbose"
                  value={confParsed.verbose}
                  onChange={(_, v) => handleField("verbose", v)}
                />
              </FormGroup>
              <FormGroup label="Intervalle" fieldId="intervals">
                <Table variant="compact" aria-label="Intervalle-Tabelle">
                  <Thead>
                    <Tr>
                      <Th>Name</Th>
                      <Th>Anzahl</Th>
                      <Th></Th>
                    </Tr>
                  </Thead>
                  <Tbody>
                    {confParsed.intervals.map((i: any, idx: number) => (
                      <Tr key={idx}>
                        <Td>
                          <TextInput value={i.name} onChange={(_, v) => handleInterval(idx, "name", v)} />
                        </Td>
                        <Td>
                          <TextInput value={i.count} onChange={(_, v) => handleInterval(idx, "count", v)} />
                        </Td>
                        <Td>
                          <Button variant="plain" aria-label="Intervall entfernen" onClick={() => removeInterval(idx)}><MinusCircleIcon /></Button>
                        </Td>
                      </Tr>
                    ))}
                  </Tbody>
                </Table>
                <Button variant="link" icon={<PlusCircleIcon />} onClick={addInterval}>Intervall hinzufügen</Button>
              </FormGroup>
              <FormGroup label="Backup-Jobs" fieldId="backups">
                <Table variant="compact" aria-label="Backups-Tabelle">
                  <Thead>
                    <Tr>
                      <Th>Quelle</Th>
                      <Th>Ziel</Th>
                      <Th>Optionen</Th>
                      <Th></Th>
                    </Tr>
                  </Thead>
                  <Tbody>
                    {confParsed.backups.map((b: any, idx: number) => (
                      <Tr key={idx}>
                        <Td>
                          <TextInput value={b.source} onChange={(_, v) => handleBackup(idx, "source", v)} />
                        </Td>
                        <Td>
                          <TextInput value={b.dest} onChange={(_, v) => handleBackup(idx, "dest", v)} />
                        </Td>
                        <Td>
                          <TextInput value={b.options} onChange={(_, v) => handleBackup(idx, "options", v)} />
                        </Td>
                        <Td>
                          <Button variant="plain" aria-label="Backup entfernen" onClick={() => removeBackup(idx)}><MinusCircleIcon /></Button>
                        </Td>
                      </Tr>
                    ))}
                  </Tbody>
                </Table>
                <Button variant="link" icon={<PlusCircleIcon />} onClick={addBackup}>Backup hinzufügen</Button>
              </FormGroup>
              <FormGroup label="Ausschlüsse (exclude/exclude_file)" fieldId="excludes">
                {confParsed.excludes.map((e: string, idx: number) => (
                  <div key={idx} style={{display: "flex", alignItems: "center", marginBottom: 4}}>
                    <TextInput value={e} onChange={(_, v) => handleExclude(idx, v)} />
                    <Button variant="plain" aria-label="Exclude entfernen" onClick={() => removeExclude(idx)}><MinusCircleIcon /></Button>
                  </div>
                ))}
                <Button variant="link" icon={<PlusCircleIcon />} onClick={addExclude}>Ausschluss hinzufügen</Button>
              </FormGroup>
              <FormGroup label="Weitere Optionen (Rohtext)" fieldId="rest">
                <TextArea
                  value={confParsed.rest.join("\n")}
                  onChange={(_, v) => setConfParsed((prev: any) => ({ ...prev, rest: v.split("\n") }))}
                  style={{ minHeight: "100px", fontFamily: "monospace" }}
                />
              </FormGroup>
            </Form>
          </StackItem>
          <StackItem>
            <div className="conf-header">
              <strong>Automatische Backups (Cronjobs):</strong>
              <Tooltip content="Cronjobs neu laden">
                <SyncAltIcon className="conf-reload" onClick={loadCron} />
              </Tooltip>
              <Tooltip content={cronHasErrors ? "Bitte korrigieren Sie die Cron-Syntax-Fehler." : "Cronjobs speichern"}>
                <span>
                  <Button
                    variant="plain"
                    aria-label="Cronjobs speichern"
                    onClick={saveCron}
                    isDisabled={cronHasErrors || isSavingCron}
                    style={{marginLeft: "0.2em"}}
                  >
                    {isSavingCron ? <Spinner size="sm" /> : <SaveIcon />}
                  </Button>
                </span>
              </Tooltip>
            </div>
            {cronConfMismatch.length > 0 && (
              <Alert
                title="Achtung: Cronjobs und rsnapshot-Konfiguration passen nicht zusammen"
                variant="warning"
                isInline
              >
                Die folgenden Cronjobs sind aktiviert, aber in der <code>rsnapshot.conf</code> fehlt das entsprechende <code>interval</code> bzw. <code>retain</code>:
                <ul>
                  {cronConfMismatch.map(name => (
                    <li key={name}><code>{name}</code></li>
                  ))}
                </ul>
                Bitte ergänzen Sie die fehlenden Intervalle in der Konfiguration, damit die Backups funktionieren!
              </Alert>
            )}
            <Form>
              {/* HOURLY */}
              <FormGroup
                fieldId="cron-hourly"
                validated={cronErrors.hourlyTime && cronSettings.hourly ? "error" : "default"}
              >
                <div style={{ display: "flex", alignItems: "center" }}>
                  <Switch
                    id="cron-hourly"
                    aria-label="Stündlich (hourly)"
                    isChecked={cronSettings.hourly}
                    onChange={() => handleCronSwitch("hourly")}
                  />
                  <label className="cron-label" htmlFor="cron-hourly-time">Stündlich (hourly)</label>
                  <TextInput
                    id="cron-hourly-time"
                    value={cronSettings.hourlyTime}
                    type="text"
                    onChange={(_event, value) => handleCronChange("hourlyTime", value)}
                    aria-label="Stündlich Zeit"
                    isDisabled={!cronSettings.hourly}
                    style={{width: "200px", marginLeft: "1em"}}
                    validated={cronErrors.hourlyTime && cronSettings.hourly ? "error" : "default"}
                  />
                  <Tooltip content="Cron-Syntax (z.B. 0 * * * *)">
                    <InfoCircleIcon style={{marginLeft: "0.5em", color: "#888", cursor: "pointer"}} />
                  </Tooltip>
                </div>
                {cronErrors.hourlyTime && cronSettings.hourly && (
                  <FormHelperText isError>{cronErrors.hourlyTime}</FormHelperText>
                )}
              </FormGroup>
              {/* DAILY */}
              <FormGroup
                fieldId="cron-daily"
                validated={cronErrors.dailyTime && cronSettings.daily ? "error" : "default"}
              >
                <div style={{ display: "flex", alignItems: "center" }}>
                  <Switch
                    id="cron-daily"
                    aria-label="Täglich (daily)"
                    isChecked={cronSettings.daily}
                    onChange={() => handleCronSwitch("daily")}
                  />
                  <label className="cron-label" htmlFor="cron-daily-time">Täglich (daily)</label>
                  <TextInput
                    id="cron-daily-time"
                    value={cronSettings.dailyTime}
                    type="text"
                    onChange={(_event, value) => handleCronChange("dailyTime", value)}
                    aria-label="Täglich Zeit"
                    isDisabled={!cronSettings.daily}
                    style={{width: "200px", marginLeft: "1em"}}
                    validated={cronErrors.dailyTime && cronSettings.daily ? "error" : "default"}
                  />
                  <Tooltip content="Cron-Syntax (z.B. 30 3 * * *)">
                    <InfoCircleIcon style={{marginLeft: "0.5em", color: "#888", cursor: "pointer"}} />
                  </Tooltip>
                </div>
                {cronErrors.dailyTime && cronSettings.daily && (
                  <FormHelperText isError>{cronErrors.dailyTime}</FormHelperText>
                )}
              </FormGroup>
              {/* WEEKLY */}
              <FormGroup
                fieldId="cron-weekly"
                validated={cronErrors.weeklyTime && cronSettings.weekly ? "error" : "default"}
              >
                <div style={{ display: "flex", alignItems: "center" }}>
                  <Switch
                    id="cron-weekly"
                    aria-label="Wöchentlich (weekly)"
                    isChecked={cronSettings.weekly}
                    onChange={() => handleCronSwitch("weekly")}
                  />
                  <label className="cron-label" htmlFor="cron-weekly-time">Wöchentlich (weekly)</label>
                  <TextInput
                    id="cron-weekly-time"
                    value={cronSettings.weeklyTime}
                    type="text"
                    onChange={(_event, value) => handleCronChange("weeklyTime", value)}
                    aria-label="Wöchentlich Zeit"
                    isDisabled={!cronSettings.weekly}
                    style={{width: "200px", marginLeft: "1em"}}
                    validated={cronErrors.weeklyTime && cronSettings.weekly ? "error" : "default"}
                  />
                  <Tooltip content="Cron-Syntax (z.B. 0 3 * * 1)">
                    <InfoCircleIcon style={{marginLeft: "0.5em", color: "#888", cursor: "pointer"}} />
                  </Tooltip>
                </div>
                {cronErrors.weeklyTime && cronSettings.weekly && (
                  <FormHelperText isError>{cronErrors.weeklyTime}</FormHelperText>
                )}
              </FormGroup>
              {/* MONTHLY */}
              <FormGroup
                fieldId="cron-monthly"
                validated={cronErrors.monthlyTime && cronSettings.monthly ? "error" : "default"}
              >
                <div style={{ display: "flex", alignItems: "center" }}>
                  <Switch
                    id="cron-monthly"
                    aria-label="Monatlich (monthly)"
                    isChecked={cronSettings.monthly}
                    onChange={() => handleCronSwitch("monthly")}
                  />
                  <label className="cron-label" htmlFor="cron-monthly-time">Monatlich (monthly)</label>
                  <TextInput
                    id="cron-monthly-time"
                    value={cronSettings.monthlyTime}
                    type="text"
                    onChange={(_event, value) => handleCronChange("monthlyTime", value)}
                    aria-label="Monatlich Zeit"
                    isDisabled={!cronSettings.monthly}
                    style={{width: "200px", marginLeft: "1em"}}
                    validated={cronErrors.monthlyTime && cronSettings.monthly ? "error" : "default"}
                  />
                  <Tooltip content="Cron-Syntax (z.B. 30 2 1 * *)">
                    <InfoCircleIcon style={{marginLeft: "0.5em", color: "#888", cursor: "pointer"}} />
                  </Tooltip>
                </div>
                {cronErrors.monthlyTime && cronSettings.monthly && (
                  <FormHelperText isError>{cronErrors.monthlyTime}</FormHelperText>
                )}
              </FormGroup>
            </Form>
          </StackItem>

          {/* Manueller Abschnitt für beide Dateien */}
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
                      onClick={saveCronRaw}
                      isDisabled={isSavingCronRaw}
                      style={{marginLeft: "0.2em"}}
                    >
                      {isSavingCronRaw ? <Spinner size="sm" /> : <SaveIcon />}
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
