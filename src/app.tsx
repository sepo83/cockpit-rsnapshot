import '@patternfly/react-core/dist/styles/base.css';
import React, { useState, useEffect } from "react";
import cockpit from "cockpit";
import {
  Page,
  PageSection,
  Title,
  Button,
  TextArea,
  Alert,
  AlertGroup,
  Stack,
  StackItem,
  Toolbar,
  ToolbarContent,
  ToolbarItem,
  Form,
  FormGroup,
  Switch,
  TextInput,
  FormHelperText,
  Tooltip,
  Spinner
} from "@patternfly/react-core";
import { SyncAltIcon, InfoCircleIcon, SaveIcon } from '@patternfly/react-icons';
import "./app.scss";

type CronSettings = {
  hourly: boolean;
  daily: boolean;
  weekly: boolean;
  monthly: boolean;
  hourlyTime: string;
  dailyTime: string;
  weeklyTime: string;
  monthlyTime: string;
};

const defaultCronSettings: CronSettings = {
  hourly: false,
  daily: false,
  weekly: false,
  monthly: false,
  hourlyTime: "0 * * * *",
  dailyTime: "30 3 * * *",
  weeklyTime: "0 3 * * 1",
  monthlyTime: "30 2 1 * *"
};

const CRON_PATH = "/etc/cron.d/rsnapshot";
const CONF_PATH = "/etc/rsnapshot.conf";

// Cron-Syntax-Validierung (einfach, prüft auf 5 Felder)
function isValidCronSyntax(s: string): boolean {
  // Hinweis: Unterstützt KEINE @reboot, @hourly etc.
  return /^([\d\/*,\-]+)\s+([\d\/*,\-]+)\s+([\d\/*,\-]+)\s+([\d\/*,\-]+)\s+([\d\/*,\-]+)$/.test(s.trim());
}

// Extrahiert alle "retain" oder "interval" Namen aus der Konfiguration
function extractIntervals(conf: string): string[] {
  const intervals: string[] = [];
  const regex = /^\s*(interval|retain)\s+([a-zA-Z0-9_-]+)\s+\d+/gm;
  let match;
  while ((match = regex.exec(conf)) !== null) {
    intervals.push(match[2]);
  }
  return intervals;
}

const App: React.FC = () => {
  const [rsnapshotAvailable, setRsnapshotAvailable] = useState<boolean | null>(null);
  const [output, setOutput] = useState("");
  const [config, setConfig] = useState("");
  const [configLoaded, setConfigLoaded] = useState(false);
  const [alerts, setAlerts] = useState<{title: string, variant: 'success'|'danger'|'warning'}[]>([]);
  const [configSaved, setConfigSaved] = useState(false);
  const [isSavingConfig, setIsSavingConfig] = useState(false);

  // Cron
  const [cronSettings, setCronSettings] = useState<CronSettings>(defaultCronSettings);
  const [cronLoaded, setCronLoaded] = useState(false);
  const [cronSaved, setCronSaved] = useState(false);
  const [isSavingCron, setIsSavingCron] = useState(false);

  // Fehlerstatus für Cron-Zeitfelder
  const [cronErrors, setCronErrors] = useState<{
    hourlyTime?: string;
    dailyTime?: string;
    weeklyTime?: string;
    monthlyTime?: string;
  }>({});

  // Für die Prüfung: Sind alle aktivierten Cronjobs auch in der Konfiguration vorhanden?
  const [confIntervals, setConfIntervals] = useState<string[]>([]);
  const [cronConfMismatch, setCronConfMismatch] = useState<string[]>([]);

  // Raw-Editing für /etc/cron.d/rsnapshot
  const [cronRawContent, setCronRawContent] = useState<string>("");
  const [cronRawLoaded, setCronRawLoaded] = useState(false);
  const [isSavingCronRaw, setIsSavingCronRaw] = useState(false);

  // === Initial-Laden ===
  useEffect(() => {
    cockpit.spawn(["which", "rsnapshot"])
      .then(() => setRsnapshotAvailable(true))
      .catch(() => setRsnapshotAvailable(false));
    loadCron();
    loadConfig();
  }, []);

  // === Prüfung, ob Cronjobs und Konfiguration zusammenpassen ===
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
        setConfIntervals(extractIntervals(data));
      })
      .catch(error => {
        setOutput("Fehler beim Laden der Konfiguration: " + (error?.message || JSON.stringify(error)) + "\n");
        setAlerts(alerts => [
          ...alerts,
          {title: "Fehler beim Laden der Konfiguration: " + (error?.message || JSON.stringify(error)), variant: "danger"}
        ]);
        setConfIntervals([]);
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
        setConfigSaved(true);
        setTimeout(() => setConfigSaved(false), 5000);
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

  const showLog = () => {
    if (!rsnapshotAvailable) return;
    setOutput("Lade Logdatei...\n");
    cockpit.spawn(["test", "-f", "/var/log/rsnapshot.log"])
      .then(() => {
        // Zeige nur die letzten 100 Zeilen für Performance
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
        const settings = { ...defaultCronSettings };
        const lines = data.split("\n");
        settings.hourly = false;
        settings.daily = false;
        settings.weekly = false;
        settings.monthly = false;
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
        setCronSettings(defaultCronSettings);
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
        setCronSaved(true);
        setTimeout(() => setCronSaved(false), 5000);
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
    cockpit.file(CRON_PATH, { superuser: "require" }).replace(cronRawContent)
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
  const handleCronSwitch = (field: keyof CronSettings) => {
    setCronSettings(prev => {
      const updated = { ...prev, [field]: !prev[field] };
      // Fehler für das Zeitfeld zurücksetzen, wenn Intervall deaktiviert wird
      if (!updated[field]) {
        let errorField: keyof typeof cronErrors | undefined;
        switch (field) {
          case "hourly": errorField = "hourlyTime"; break;
          case "daily": errorField = "dailyTime"; break;
          case "weekly": errorField = "weeklyTime"; break;
          case "monthly": errorField = "monthlyTime"; break;
          default: errorField = undefined;
        }
        if (errorField) {
          setCronErrors(prevErrors => ({ ...prevErrors, [errorField]: undefined }));
        }
      }
      return updated;
    });
  };

  // Handler für Zeitfeld-Änderung
  const handleCronChange = (field: keyof CronSettings, value: any) => {
    setCronSettings(prev => ({ ...prev, [field]: value }));

    // Validierung nur für Zeitfelder
    if (
      field === "hourlyTime" ||
      field === "dailyTime" ||
      field === "weeklyTime" ||
      field === "monthlyTime"
    ) {
      const isValid = isValidCronSyntax(value);
      setCronErrors(prev => ({
        ...prev,
        [field]: isValid ? undefined : "Ungültige Cron-Syntax (5 Felder, z.B. 0 * * * *)"
      }));
    }
  };

  // Button deaktivieren, wenn ein Fehler in einem aktivierten Zeitfeld vorliegt
  const cronHasErrors = (
    (cronSettings.hourly && !!cronErrors.hourlyTime) ||
    (cronSettings.daily && !!cronErrors.dailyTime) ||
    (cronSettings.weekly && !!cronErrors.weeklyTime) ||
    (cronSettings.monthly && !!cronErrors.monthlyTime)
  );

  // === Prüfung: Cronjobs vs. Konfiguration ===
  function checkCronConfigMatch() {
    const missing: string[] = [];
    if (cronSettings.hourly && !confIntervals.includes("hourly")) missing.push("hourly");
    if (cronSettings.daily && !confIntervals.includes("daily")) missing.push("daily");
    if (cronSettings.weekly && !confIntervals.includes("weekly")) missing.push("weekly");
    if (cronSettings.monthly && !confIntervals.includes("monthly")) missing.push("monthly");
    setCronConfMismatch(missing);
  }

  // === RENDER ===

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
            <div className="conf-header">
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
            <TextArea
              value={config}
              onChange={(_event, value) => setConfig(value)}
              style={{ minHeight: "200px", fontFamily: "monospace" }}
              placeholder="Hier erscheint die rsnapshot.conf"
              isDisabled={!rsnapshotAvailable}
              aria-label="rsnapshot Konfiguration"
            />
          </StackItem>
          <StackItem>
            <div className="conf-header">
              <Title headingLevel="h2" size="md" style={{margin: 0}}>Automatische Backups (Cronjobs)</Title>
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

          {/* Nur noch das Bearbeiten der Datei, keine Anzeige mehr */}
          <StackItem>
            <div className="conf-header">
              <strong>/etc/cron.d/rsnapshot bearbeiten:</strong>
              <Tooltip content="Cron-Datei neu laden">
                <SyncAltIcon className="conf-reload" onClick={loadCron} />
              </Tooltip>
              <Tooltip content="Cron-Datei speichern">
                <Button
                  variant="plain"
                  aria-label="Cron-Datei speichern"
                  onClick={saveCronRaw}
                  isDisabled={!cronRawLoaded || isSavingCronRaw}
                  style={{marginLeft: "0.2em"}}
                >
                  {isSavingCronRaw ? <Spinner size="sm" /> : <SaveIcon />}
                </Button>
              </Tooltip>
            </div>
            <TextArea
              value={cronRawContent}
              onChange={(_event, value) => setCronRawContent(value)}
              style={{ minHeight: "150px", fontFamily: "monospace" }}
              placeholder="Hier erscheint die /etc/cron.d/rsnapshot"
              isDisabled={!rsnapshotAvailable || !cronRawLoaded}
              aria-label="rsnapshot Cron-Datei"
            />
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
