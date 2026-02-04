import { Card, CardHeader, Badge } from "@/components/ui";
import { SetupWizard } from "@/components/setup-wizard";

export default function SetupPage() {
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Setup</h1>
          <p className="mt-2 text-sm text-[rgb(var(--claw-muted))]">
            Configure your Clawboard instance and integration level.
          </p>
        </div>
        <Badge tone="accent">Onboarding</Badge>
      </div>

      <Card>
        <CardHeader>
          <h2 className="text-lg font-semibold">Instance Configuration</h2>
        </CardHeader>
        <SetupWizard />
      </Card>
    </div>
  );
}
