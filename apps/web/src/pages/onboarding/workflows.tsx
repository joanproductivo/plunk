import {Button, Skeleton} from '@plunk/ui';
import {motion} from 'framer-motion';
import {ArrowLeft, ArrowRight, FileText, ShieldCheck, Workflow, Zap} from 'lucide-react';
import {NextSeo} from 'next-seo';
import Link from 'next/link';
import {useRouter} from 'next/router';
import {useEffect, useMemo} from 'react';

import {ApiKeyDisplay} from '../../components/ApiKeyDisplay';
import {CodeTabs, type CodeSnippet} from '../../components/onboarding/CodeTabs';
import {OnboardingLayout} from '../../components/onboarding/OnboardingLayout';
import {API_URI} from '../../lib/constants';
import {useActiveProject} from '../../lib/contexts/ActiveProjectProvider';
import {useOnboardingGate} from '../../lib/hooks/useOnboardingGate';
import {useOnboardingPath} from '../../lib/hooks/useOnboardingPath';

interface SetupStep {
  id: string;
  icon: React.ElementType;
  title: string;
  description: string;
  cta?: string;
  href?: string;
  required?: boolean;
}

const steps: SetupStep[] = [
  {
    id: 'domain',
    icon: ShieldCheck,
    title: 'Verify your sender domain',
    description: 'Workflows send from a verified domain. Two DNS records and you\'re set.',
    cta: 'Verify domain',
    href: '/settings?tab=domains',
    required: true,
  },
  {
    id: 'track',
    icon: Zap,
    title: 'Fire events from your app',
    description: 'Call /v1/track whenever something interesting happens. Workflows listen and respond.',
  },
  {
    id: 'template',
    icon: FileText,
    title: 'Create an email template',
    description: 'Design the email your workflow will send — drag blocks or write HTML.',
    cta: 'Create template',
    href: '/templates/create',
  },
  {
    id: 'workflow',
    icon: Workflow,
    title: 'Build your first workflow',
    description: 'Pick a trigger event, attach your template, chain delays, hit publish.',
    cta: 'Open workflow builder',
    href: '/workflows',
  },
];

// Plunk Lite: server code, so it uses the secret key -- /v1/track takes it, and a server can switch
// the public key off (PLUNK_LITE_PUBLIC_TRACK=off)
function buildTrackSnippets(apiUrl: string, secretKey: string): CodeSnippet[] {
  const body = {
    event: 'user.signed-up',
    email: 'user@example.com',
    data: {plan: 'pro'},
  };

  const curl = `curl -X POST ${apiUrl}/v1/track \\
  -H "Authorization: Bearer ${secretKey}" \\
  -H "Content-Type: application/json" \\
  -d '${JSON.stringify(body, null, 2).replace(/\n/g, '\n    ')}'`;

  const node = `await fetch("${apiUrl}/v1/track", {
  method: "POST",
  headers: {
    Authorization: "Bearer ${secretKey}",
    "Content-Type": "application/json",
  },
  body: JSON.stringify(${JSON.stringify(body, null, 2).replace(/\n/g, '\n  ')}),
});`;

  const python = `import requests

requests.post(
    "${apiUrl}/v1/track",
    headers={"Authorization": "Bearer ${secretKey}"},
    json=${JSON.stringify(body, null, 4).replace(/\n/g, '\n    ')},
)`;

  const php = `$ch = curl_init("${apiUrl}/v1/track");
curl_setopt_array($ch, [
    CURLOPT_POST => true,
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_HTTPHEADER => [
        "Authorization: Bearer ${secretKey}",
        "Content-Type: application/json",
    ],
    CURLOPT_POSTFIELDS => json_encode(${JSON.stringify(body, null, 4).replace(/\n/g, '\n        ')}),
]);
curl_exec($ch);`;

  return [
    {id: 'curl', label: 'cURL', code: curl},
    {id: 'node', label: 'Node.js', code: node},
    {id: 'python', label: 'Python', code: python},
    {id: 'php', label: 'PHP', code: php},
  ];
}

export default function OnboardingWorkflows() {
  const router = useRouter();
  const {activeProject} = useActiveProject();
  const {state} = useOnboardingGate();
  const {path, setPath} = useOnboardingPath(activeProject?.id);

  const snippets = useMemo(
    () => buildTrackSnippets(API_URI, activeProject?.secret ?? 'sk_your_secret_key'),
    [activeProject?.secret],
  );

  useEffect(() => {
    if (activeProject && !path) setPath('workflows');
  }, [activeProject, path, setPath]);

  if (state !== 'show') return null;

  const handleContinue = () => {
    void router.push('/');
  };

  const handleStepClick = (href: string) => {
    void router.push(href);
  };

  return (
    <>
      <NextSeo title="Automate with workflows" />
      <OnboardingLayout step={2}>
        <div className="flex flex-col gap-6">
          <header className="flex flex-col gap-2">
            <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-neutral-900">
              Automate with workflows.
            </h1>
            <p className="text-base text-neutral-600 max-w-xl leading-relaxed">
              Four steps to your first automated email. Start with your domain so emails actually reach the inbox.
            </p>
          </header>

          <div className="flex flex-col gap-3">
            {steps.map((step, index) => {
              const Icon = step.icon;
              return (
                <motion.div
                  key={step.id}
                  initial={{opacity: 0, y: 6}}
                  animate={{opacity: 1, y: 0}}
                  transition={{duration: 0.3, delay: 0.05 + index * 0.06, ease: [0.22, 1, 0.36, 1]}}
                  className="flex flex-col gap-4 rounded-xl border border-neutral-200 bg-white p-5 shadow-sm"
                >
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex items-start gap-4">
                      <div className="flex items-center gap-3">
                        <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full border border-neutral-200 bg-neutral-50 text-xs font-semibold tabular-nums text-neutral-900">
                          {index + 1}
                        </span>
                        <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg border border-neutral-200 bg-neutral-50 text-neutral-900">
                          <Icon className="h-5 w-5" />
                        </span>
                      </div>
                      <div className="flex flex-col gap-1 pt-0.5">
                        <div className="flex items-center gap-2">
                          <h2 className="text-sm font-semibold text-neutral-900">{step.title}</h2>
                          {step.required && (
                            <span className="rounded bg-neutral-900 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-white">
                              Required
                            </span>
                          )}
                        </div>
                        <p className="text-sm text-neutral-600 leading-relaxed">{step.description}</p>
                      </div>
                    </div>
                    {step.cta && step.href && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="sm:self-center sm:flex-shrink-0"
                        onClick={() => handleStepClick(step.href!)}
                      >
                        {step.cta}
                        <ArrowRight className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>

                  {step.id === 'track' && (
                    <div className="flex flex-col gap-3 border-t border-neutral-100 pt-4">
                      {activeProject ? (
                        <ApiKeyDisplay
                          label="Secret key"
                          value={activeProject.secret}
                          description="Keep this server-side. Treat it like a password."
                          isSecret
                        />
                      ) : (
                        <Skeleton className="h-16 rounded-lg" />
                      )}
                      <div className="overflow-hidden rounded-lg border border-neutral-200">
                        <CodeTabs snippets={snippets} />
                      </div>
                    </div>
                  )}
                </motion.div>
              );
            })}
          </div>

          <div className="flex items-center justify-between pt-2">
            <Link
              href="/onboarding"
              className="inline-flex items-center gap-1.5 text-sm font-medium text-neutral-500 hover:text-neutral-900 transition-colors"
            >
              <ArrowLeft className="h-4 w-4" />
              Back
            </Link>
            <Button onClick={handleContinue}>
              Continue to dashboard
              <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </OnboardingLayout>
    </>
  );
}
