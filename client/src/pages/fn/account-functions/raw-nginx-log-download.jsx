import { RawLogDownload } from '../../accounts/RawLogDownload.jsx';

export default function RawNginxLogDownload({ fn }) {
  return <RawLogDownload fn={fn} kind="nginx" description="Downloads the raw NGINX logs that mention one of the account's domains (/var/log/nginx) and any nginx log in the account's ~/logs. Requires NGINX on this server." />;
}
