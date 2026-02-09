import { Card, CardHeader } from "@/components/ui";
import { SetupWizard } from "@/components/setup-wizard";

		export default function SetupPage() {
		  return (
		    <div className="space-y-6">
		      <Card>
		        <CardHeader>
		          <h2 className="text-lg font-semibold">Instance Configuration</h2>
		        </CardHeader>
        <SetupWizard />
      </Card>
    </div>
  );
}
