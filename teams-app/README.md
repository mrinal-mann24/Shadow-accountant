# Shadow Teams app package

The Teams app that installs the Shadow bot. `manifest.template.json` is the source; the package is built into
`teams-app/dist/` (git ignored).

1. Get the Microsoft App ID (client id, a GUID) of the Shadow Azure Bot. The bot's messaging endpoint must be
   `https://<site>/api/teams/messages`.
2. Build the package from the repo root:
   `node scripts/teams-app.mjs <APP_ID> [SITE_URL]`
   SITE_URL defaults to `https://shadow.aiaccountant.com`. The script prints the path of
   `teams-app/dist/shadow-teams-app.zip` (manifest.json, color.png, outline.png).
3. Upload the zip. For the whole organisation: Teams admin centre > Teams apps > Manage apps > Upload new app.
   For a quick test: Teams > Apps > Manage your apps > Upload a custom app.
4. Add the app to the **VA Ops** team (Apps > Shadow > Add to a team > VA Ops).
5. In each Senior Accountant's channel, an Admin or Engineer mentions the bot and types
   `link <accountant email>`. In the Escalations channel, type `link escalations`.
6. Type `channels` to check the links and `help` to see every command. After a manifest change, raise
   `version` in the template, rebuild and upload the new zip as an update.
