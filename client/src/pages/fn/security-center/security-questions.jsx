import { ConfigPage } from '../../../components/ConfigPage.jsx';

export default function SecurityQuestions({ fn }) {
  return (
    <ConfigPage fn={fn} prefix="security.questions." description="Recovery questions for account users. Not enforced yet: the settings are stored for the authentication layer, which does not prompt for questions on login or password reset today."
      extra={<div className="banner banner-warning"><div>Enabling security questions here changes nothing for users yet. The login and password-reset flows must consume these settings before any question is asked; the Security Advisor flags the policy while it is switched on but inactive.</div></div>}
      groups={[
        { title: 'Policy', fields: [
          { key: 'security.questions.enabled', label: 'Require security questions', type: 'toggle', help: 'Intended behaviour: account users set up their questions on their next login. Stored only; not enforced yet.' },
          { key: 'security.questions.required_count', label: 'Questions each user must answer', type: 'number', min: 1, max: 10 },
          { key: 'security.questions.min_answer_length', label: 'Minimum answer length', type: 'number', min: 1, max: 100 },
          { key: 'security.questions.allow_custom', label: 'Allow users to write their own questions', type: 'toggle' },
        ] },
        { title: 'Question pool', description: 'One question per entry; users will pick from this list once enforcement lands.', fields: [
          { key: 'security.questions.pool', label: 'Questions', type: 'list', help: 'Comma-separated. Keep answers hard to look up on social media.' },
        ] },
      ]} />
  );
}
