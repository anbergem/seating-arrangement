import { useT } from "@agent-native/core/client/i18n";
import {
  TeamPage,
  useAcceptInvitation,
  useOrg,
} from "@agent-native/core/client/org";

export function InviteOnlyTeamPage() {
  const t = useT();
  const { data: org, error, isLoading } = useOrg();
  const acceptInvitation = useAcceptInvitation();

  if (isLoading) {
    return (
      <p className="text-sm text-muted-foreground">{t("pages.teamLoading")}</p>
    );
  }

  if (error) {
    return (
      <p className="text-sm text-destructive" role="alert">
        {t("pages.teamLoadError")}
      </p>
    );
  }

  if (!org?.orgId) {
    return (
      <section className="rounded-lg border border-border bg-card p-4 space-y-3">
        <h2 className="text-sm font-medium">
          {t("pages.teamNoOrganizationTitle")}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t("pages.teamNoOrganizationDescription")}
        </p>
        {org?.pendingInvitations?.map((invitation) => (
          <div
            className="flex items-center justify-between rounded-md border border-border p-3"
            key={invitation.id}
          >
            <span className="text-sm font-medium">{invitation.orgName}</span>
            <button
              aria-label={t("pages.acceptInvitation", {
                name: invitation.orgName,
              })}
              className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground"
              disabled={acceptInvitation.isPending}
              onClick={() => acceptInvitation.mutate(invitation.id)}
              type="button"
            >
              {t("pages.acceptInvitation", { name: invitation.orgName })}
            </button>
          </div>
        ))}
        {acceptInvitation.error ? (
          <p className="text-sm text-destructive" role="alert">
            {t("pages.teamInvitationError")}
          </p>
        ) : null}
      </section>
    );
  }

  // `invite-only-team` hides the framework's email-domain auto-join row; the
  // rule and the reason live in app/global.css.
  return (
    <div className="invite-only-team">
      <TeamPage showTitle={false} />
    </div>
  );
}
