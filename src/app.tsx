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
  TextInput
} from "@patternfly/react-core";
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

const App: React.FC = () => {
  const [rsnapshotAvailable, setRsnapshotAvailable] = useState<boolean | null>(null);
  const [output, setOutput] = useState("");
  const [config, setConfig] = useState("");
  const [configLoaded, setConfigLoaded] = useState(false);
  const [alerts, setAlerts] = useState<{title: string, variant: 'success'|'danger'}[]>([]);
  const [configSaved, setConfigSaved] = useState(false);

  // Cron
  const [cronSettings, setCronSettings] = useState<CronSettings>(defaultCronSettings);
  const [cronLoaded, setCronLoaded] = useState(false);
  const [cronSaved, setCronSaved] = useState(false);
  const [cronFileContent, setCronFileContent] = useState<string>("");

  useEffect(() => {
    cockpit.spawn(["which", "rsnapshot"])
      .then(() => setRsnapshotAvailable(true))
      .catch(() => setRsnapshotAvailable(false));
    loadCron();
  }, []);

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
        setOutput(prev => prev + "\nFehler beim Backup: " + error + "\n");
        setAlerts(alerts => [...alerts, {title: "Fehler beim Backup", variant: "danger"}]);
      });
  };

  const showConfig = () => {
    if (!rsnapshotAvailable) return;
    setOutput("Lade Konfiguration...\n");
    cockpit.spawn(["cat", "/etc/rsnapshot.conf"])
      .then(data => {
        setConfig(data);
        setConfigLoaded(true);
        setOutput("Konfiguration geladen.\n");
      })
      .catch(error => {
        setOutput("Fehler beim Laden der Konfiguration: " + error + "\n");
        setAlerts(alerts => [...alerts, {title: "Fehler beim Laden der Konfiguration", variant: "danger"}]);
      });
  };

  const saveConfig = () => {
    if (!rsnapshotAvailable) return;
    setOutput("Speichere Konfiguration...\n");
    cockpit.file("/etc/rsnapshot.conf", { superuser: "require" }).replace(config)
      .then(() => {
        setOutput("Konfiguration gespeichert.\n");
        setAlerts(alerts => [...alerts, {title: "Konfiguration gespeichert", variant: "success"}]);
        setConfigSaved(true);
        setTimeout(() => setConfigSaved(false), 5000);
      })
      .catch(error => {
        setOutput("Fehler beim Speichern der Konfiguration: " + error + "\n");
        setAlerts(alerts => [...alerts, {title: "Fehler beim Speichern der Konfiguration", variant: "danger"}]);
      });
  };

  const showLog = () => {
    if (!rsnapshotAvailable) return;
    setOutput("Lade Logdatei...\n");
    cockpit.spawn(["test", "-f", "/var/log/rsnapshot.log"])
      .then(() => {
        cockpit.spawn(["cat", "/var/log/rsnapshot.log"])
          .then(data => setOutput(data))
          .catch(error => {
            setOutput("Fehler beim Laden der Logdatei: " + error + "\n");
            setAlerts(alerts => [...alerts, {title: "Fehler beim Laden der Logdatei", variant: "danger"}]);
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
        // Flags für Aktivierung
        settings.hourly = false;
        settings.daily = false;
        settings.weekly = false;
        settings.monthly = false;
        for (const line of lines) {
          // Prüfe, ob die Zeile auskommentiert ist (egal wie viele Leerzeichen davor)
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
        setCronFileContent(data);
      })
      .catch(() => {
        setCronSettings(defaultCronSettings);
        setCronLoaded(true);
        setCronFileContent("");
      });
  };

  const saveCron = () => {
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
        loadCron(); // Synchronisiere UI nach Speichern
      })
      .catch(error => {
        setAlerts(alerts => [...alerts, {title: "Fehler beim Speichern der Cronjobs: " + error, variant: "danger"}]);
      });
  };

  // Funktionale Variante!
  const handleCronChange = (field: keyof CronSettings, value: any) => {
    setCronSettings(prev => ({ ...prev, [field]: value }));
  };

  return (
    <Page className="no-masthead-sidebar">
      <PageSection>
        <Title headingLevel="h1" size="lg">rsnapshot Verwaltung</Title>
        <AlertGroup isToast>
          {alerts.map((alert, idx) => (
            <Alert key={idx} title={alert.title} variant={alert.variant} timeout={5000} />
          ))}
        </AlertGroup>
        {configSaved && (
          <Alert title="Konfiguration erfolgreich gespeichert" variant="success" isInline>
            Die Datei <code>/etc/rsnapshot.conf</code> wurde erfolgreich gespeichert.
          </Alert>
        )}
        {cronSaved && (
          <Alert title="Cronjobs erfolgreich gespeichert" variant="success" isInline>
            Die Datei <code>{CRON_PATH}</code> wurde erfolgreich gespeichert.
          </Alert>
        )}
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
              <Button variant="secondary" onClick={showConfig} isDisabled={!rsnapshotAvailable}>Konfiguration anzeigen</Button>
            </ToolbarItem>
            <ToolbarItem>
              <Button variant="primary" onClick={saveConfig} isDisabled={!configLoaded || !rsnapshotAvailable}>Konfiguration speichern</Button>
            </ToolbarItem>
            <ToolbarItem>
              <Button variant="secondary" onClick={showLog} isDisabled={!rsnapshotAvailable}>Log anzeigen</Button>
            </ToolbarItem>
          </ToolbarContent>
        </Toolbar>
        <Stack hasGutter>
          <StackItem>
            <strong>Ausgabe / Log:</strong>
            <pre style={{background: "#f8f8f8", padding: "1em", border: "1px solid #ccc", minHeight: "100px"}}>{output}</pre>
          </StackItem>
          <StackItem>
            <strong>rsnapshot Konfiguration:</strong>
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
            <Title headingLevel="h2" size="md">Automatische Backups (Cronjobs)</Title>
            <Form>
              <FormGroup label="Stündlich (hourly)" fieldId="cron-hourly">
                <Switch
                  id="cron-hourly"
                  aria-label="Stündlich (hourly)"
                  isChecked={cronSettings.hourly}
                  onChange={checked => handleCronChange("hourly", checked)}
                />
                <TextInput
                  value={cronSettings.hourlyTime}
                  type="text"
                  onChange={(_event, value) => handleCronChange("hourlyTime", value)}
                  aria-label="Stündlich Zeit"
                  isDisabled={!cronSettings.hourly}
                  style={{width: "200px", marginLeft: "1em"}}
                />
                <span style={{marginLeft: "1em"}}>Cron-Syntax (z.B. <code>0 * * * *</code>)</span>
              </FormGroup>
              <FormGroup label="Täglich (daily)" fieldId="cron-daily">
                <Switch
                  id="cron-daily"
                  aria-label="Täglich (daily)"
                  isChecked={cronSettings.daily}
                  onChange={checked => handleCronChange("daily", checked)}
                />
                <TextInput
                  value={cronSettings.dailyTime}
                  type="text"
                  onChange={(_event, value) => handleCronChange("dailyTime", value)}
                  aria-label="Täglich Zeit"
                  isDisabled={!cronSettings.daily}
                  style={{width: "200px", marginLeft: "1em"}}
                />
                <span style={{marginLeft: "1em"}}>Cron-Syntax (z.B. <code>30 3 * * *</code>)</span>
              </FormGroup>
              <FormGroup label="Wöchentlich (weekly)" fieldId="cron-weekly">
                <Switch
                  id="cron-weekly"
                  aria-label="Wöchentlich (weekly)"
                  isChecked={cronSettings.weekly}
                  onChange={checked => handleCronChange("weekly", checked)}
                />
                <TextInput
                  value={cronSettings.weeklyTime}
                  type="text"
                  onChange={(_event, value) => handleCronChange("weeklyTime", value)}
                  aria-label="Wöchentlich Zeit"
                  isDisabled={!cronSettings.weekly}
                  style={{width: "200px", marginLeft: "1em"}}
                />
                <span style={{marginLeft: "1em"}}>Cron-Syntax (z.B. <code>0 3 * * 1</code>)</span>
              </FormGroup>
              <FormGroup label="Monatlich (monthly)" fieldId="cron-monthly">
                <Switch
                  id="cron-monthly"
                  aria-label="Monatlich (monthly)"
                  isChecked={cronSettings.monthly}
                  onChange={checked => handleCronChange("monthly", checked)}
                />
                <TextInput
                  value={cronSettings.monthlyTime}
                  type="text"
                  onChange={(_event, value) => handleCronChange("monthlyTime", value)}
                  aria-label="Monatlich Zeit"
                  isDisabled={!cronSettings.monthly}
                  style={{width: "200px", marginLeft: "1em"}}
                />
                <span style={{marginLeft: "1em"}}>Cron-Syntax (z.B. <code>30 2 1 * *</code>)</span>
              </FormGroup>
              <Button variant="primary" onClick={saveCron}>Cronjobs speichern</Button>
            </Form>
            {cronLoaded && (
              <div style={{marginTop: "1em"}}>
                <strong>Aktuelle /etc/cron.d/rsnapshot:</strong>
                <pre style={{background: "#f8f8f8", padding: "1em", border: "1px solid #ccc", minHeight: "100px"}}>
                  {cronFileContent}
                </pre>
              </div>
            )}
          </StackItem>
        </Stack>
      </PageSection>
    </Page>
  );
};

export default App;
