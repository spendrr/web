// When a change seen by the dashboard should arm the cloud-backup upload.
//
// The first balance and history read after the dashboard mounts is not a change:
// the refs that hold the previous values are still empty, so every field reads as
// "changed". Arming the uploader for it ran a full dump of the databases a few
// seconds after every open, found it identical to the last upload and threw it
// away, on top of the one-shot upload that already runs right after unlock. On a
// large wallet each such cycle froze the page for over a second.
export function shouldTriggerBackup(c: { firstLoad: boolean; balanceChanged: boolean; historyChanged: boolean }): boolean {
  return !c.firstLoad && (c.balanceChanged || c.historyChanged);
}
