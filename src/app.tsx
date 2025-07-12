import React, { useState } from "react";
import cockpit from "cockpit";
import "./app.scss";

const App: React.FC = () => {
  const [output, setOutput] = useState("");
  const [config, setConfig] = useState("");
  const [configLoaded, setConfigLoaded] = useState(false);

  const runBackup = () => {
    setOutput("Starte rsnapshot-Backup...\n");
    cockpit.spawn(["sudo", "rsnapshot", "daily"])
      .stream(data => setOutput(prev => prev + data))
      .then(() => setOutput(prev => prev + "\nBackup abgeschlossen.\n"))
      .catch(error => setOutput(prev => prev + "\nFehler beim Backup: " + error + "\n"));
  };

  const showConfig = () => {
    setOutput("Lade Konfiguration...\n");
    cockpit.spawn(["cat", "/etc/rsnapshot.conf"])
      .then(data => {
        setConfig(data);
        setConfigLoaded(true);
        setOutput("Konfiguration geladen.\n");
      })
      .catch(error => setOutput("Fehler beim Laden der Konfiguration: " + error + "\n"));
  };

  const saveConfig = () => {
    setOutput("Speichere Konfiguration...\n");
    cockpit.spawn(["sudo", "./write-config.sh"], { input: config })
      .then(() => setOutput("Konfiguration gespeichert.\n"))
      .catch(error => setOutput("Fehler beim Speichern der Konfiguration: " + error + "\n"));
  };

  const showLog = () => {
    setOutput("Lade Logdatei...\n");
    cockpit.spawn(["cat", "/var/log/rsnapshot"])
      .then(data => setOutput(data))
      .catch(error => setOutput("Fehler beim Laden der Logdatei: " + error + "\n"));
  };

  return (
    <div>
      <h1>rsnapshot Verwaltung</h1>
      <div className="button-row">
        <button className="btn btn-primary" onClick={runBackup}>Backup starten</button>
        <button className="btn btn-secondary" onClick={showConfig}>Konfiguration anzeigen</button>
        <button className="btn btn-success" onClick={saveConfig} disabled={!configLoaded}>Konfiguration speichern</button>
        <button className="btn btn-secondary" onClick={showLog}>Log anzeigen</button>
      </div>
      <label><strong>Ausgabe / Log:</strong></label>
      <pre>{output}</pre>
      <label><strong>rsnapshot Konfiguration:</strong></label>
      <textarea
        style={{ width: "100%", minHeight: "200px", fontFamily: "monospace" }}
        value={config}
        onChange={e => setConfig(e.target.value)}
        placeholder="Hier erscheint die rsnapshot.conf"
      />
    </div>
  );
};

export default App;
