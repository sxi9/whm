import { RawLogDownload } from '../../accounts/RawLogDownload.jsx';

export default function RawApacheLogDownload({ fn }) {
  return <RawLogDownload fn={fn} kind="apache" description="Downloads the raw per-domain access and error logs Apache writes for an account (/var/log/whm/domlogs/<user>), plus the PHP error log in the account's ~/logs. Rotated files (.1, .gz) are included." />;
}
