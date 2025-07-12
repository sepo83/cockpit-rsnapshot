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
  ToolbarItem
} from "@patternfly/react-core";
import "./app.scss";

const App: React.FC = () => {
  const [rsnapshotAvailable, setRsnapshotAvailable] = useState<boolean | null>(null);
  const [output, setOutput] = useState("");
  const [config, setConfig] = useState("");
  const [configLoaded, setConfigLoaded] = useState(false);
  const [alerts, setAlerts] = useState<{title: string, variant: 'success'|'danger'}[]>([]);
  const [configSaved, setConfigSaved] = useState(false);

  // Beim Laden prüfen, ob rsnapshot installiert ist
  useEffect(() => {
    cockpit.spawn(["which", "rsnapshot"])
      .then(() => setRsnapshotAvailable(true))
      .catch(() => setRsnapshotAvailable(false));
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
  cockpit.file("/etc/rsnapshot.conf").replace(config, { superuser: "require" })
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
    // Prüfe, ob das Logfile existiert
    cockpit.spawn(["test", "-f", "/var/log/rsnapshot.log"])
      .then(() => {
        // Datei existiert, jetzt lesen
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
              <Button variant="success" onClick={saveConfig} isDisabled={!configLoaded || !rsnapshotAvailable}>Konfiguration speichern</Button>
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
            />
          </StackItem>
        </Stack>
      </PageSection>
    </Page>
  );
};

export default App;
