import { ConfigPage } from '../../../components/ConfigPage.jsx';

export default function SecurityQuestions({ fn }) {
  return (
    <ConfigPage fn={fn} prefix="security.questions." description="Recovery questions that account users answer when they log in from an unrecognised address or reset a password." groups={[
      { title: 'Policy', fields: [
        { key: 'security.questions.enabled', label: 'Require security questions', type: 'toggle', help: 'When enabled, account users must set up their questions on their next login.' },
        { key: 'security.questions.required_count', label: 'Questions each user must answer', type: 'number', min: 1, max: 10 },
        { key: 'security.questions.min_answer_length', label: 'Minimum answer length', type: 'number', min: 1, max: 100 },
        { key: 'security.questions.allow_custom', label: 'Allow users to write their own questions', type: 'toggle' },
      ] },
      { title: 'Question pool', description: 'One question per entry; users pick from this list.', fields: [
        { key: 'security.questions.pool', label: 'Questions', type: 'list', help: 'Comma-separated. Keep answers hard to look up on social media.' },
      ] },
    ]} />
  );
}
