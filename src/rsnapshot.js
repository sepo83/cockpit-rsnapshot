// rsnapshot.js

// Funktion: Backup starten
document.getElementById("run-backup").onclick = function() {
    setOutput("Starte rsnapshot-Backup...\n");
    cockpit.spawn(["sudo", "rsnapshot", "daily"])
        .stream(function(data) {
            appendOutput(data);
        })
        .then(function() {
            appendOutput("\nBackup abgeschlossen.\n");
        })
        .catch(function(error) {
            appendOutput("\nFehler beim Backup: " + error + "\n");
        });
};

// Funktion: Konfiguration anzeigen
document.getElementById("show-config").onclick = function() {
    setOutput("Lade Konfiguration...\n");
    cockpit.spawn(["cat", "/etc/rsnapshot.conf"])
        .then(function(data) {
            document.getElementById("config-editor").value = data;
            appendOutput("Konfiguration geladen.\n");
        })
        .catch(function(error) {
            appendOutput("Fehler beim Laden der Konfiguration: " + error + "\n");
        });
};

// Funktion: Konfiguration speichern
document.getElementById("save-config").onclick = function() {
    let newConfig = document.getElementById("config-editor").value;
    setOutput("Speichere Konfiguration...\n");
    // Schreibe neuen Inhalt über ein Backend-Skript (write-config.sh)
    cockpit.spawn(["sudo", "./write-config.sh"], { input: newConfig })
        .then(function() {
            appendOutput("Konfiguration gespeichert.\n");
        })
        .catch(function(error) {
            appendOutput("Fehler beim Speichern der Konfiguration: " + error + "\n");
        });
};

// Funktion: Log anzeigen
document.getElementById("show-log").onclick = function() {
    setOutput("Lade Logdatei...\n");
    cockpit.spawn(["cat", "/var/log/rsnapshot"])
        .then(function(data) {
            setOutput(data);
        })
        .catch(function(error) {
            setOutput("Fehler beim Laden der Logdatei: " + error + "\n");
        });
};

// Hilfsfunktionen für die Ausgabe
function setOutput(text) {
    document.getElementById("output").textContent = text;
}
function appendOutput(text) {
    document.getElementById("output").textContent += text;
}
