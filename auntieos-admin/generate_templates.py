import zipfile
import os

# Brand Identity
BRAND_ORANGE = "#df8431"
BRAND_CREAM = "#fbfbf9"
BRAND_NAVY = "#11131f"
PACK_PINK = "#d55c87"
SNUGGLE_CORAL = "#D5535A"

def generate_html(title, body_content, is_security=False):
    accent_color = SNUGGLE_CORAL if is_security else BRAND_ORANGE
    return f"""<!DOCTYPE html>
<html>
<head>
    <style>
        body {{ background-color: {BRAND_CREAM}; color: {BRAND_NAVY}; font-family: 'Segoe UI', Tahoma, sans-serif; line-height: 1.6; margin: 0; padding: 0; }}
        .container {{ max-width: 600px; margin: 20px auto; background: #ffffff; border-top: 8px solid {accent_color}; border-bottom: 4px solid {BRAND_NAVY}; }}
        .header {{ padding: 30px 40px 10px 40px; }}
        .content {{ padding: 10px 40px 30px 40px; font-size: 16px; }}
        .footer {{ padding: 20px 40px; background-color: {BRAND_NAVY}; color: {BRAND_CREAM}; font-size: 12px; text-align: center; }}
        .button {{ display: inline-block; padding: 14px 28px; background: {BRAND_ORANGE}; color: #ffffff; text-decoration: none; border-radius: 4px; font-weight: bold; margin: 20px 0; }}
        .alert-box {{ background-color: #fff5f5; border-left: 4px solid {SNUGGLE_CORAL}; padding: 15px; margin: 20px 0; }}
    </style>
</head>
<body>
    <div class="container">
        <div class="header"><h2>{title}</h2></div>
        <div class="content">
            {body_content}
            <p>With care,<br><strong>Auntie</strong></p>
        </div>
        <div class="footer">Tribe Tails Pet Care..Your Kin’s Favorite Auntie</div>
    </div>
</body>
</html>"""

keys = [
    {"id": "auth.failedLogin.attempts", "title": "Security: Unusual login activity detected", "is_sec": True, "body": "Hello {{kinfolkName}}. I declare: someone is having a time trying to log into your account. I have noticed multiple failed attempts recently. I take this very seriously when it comes to your family and the Kin I love. Not on my watch."},
    {"id": "auth.account.locked", "title": "Security: I have locked your account for your protection", "is_sec": True, "body": "Hello {{kinfolkName}}. Please do not delay in reading this. I have seen too many failed attempts to access your account, so I have locked it down to keep everything safe. I will not have unauthorized access to your information on my watch."},
    {"id": "account.welcome.kinfolk", "title": "Ooooweeeee: Welcome to the Tribe Tails Pet Care family", "is_sec": False, "body": "Hello {{kinfolkName}}. I am so glad you are here! I have set everything up so you can manage care for your Kin with ease. I shall be here every step of the way to ensure your family is loved and looked after."},
    {"id": "account.welcome.business", "title": "Welcome: It is official", "is_sec": False, "body": "Hello. I have linked your account to our business portal. I shall handle the details while you focus on the Kin."},
    {"id": "kincare.requested", "title": "I received your care request for {{kinName}}", "is_sec": False, "body": "Hello {{kinfolkName}}. I have received your request for a {{serviceType}} on {{bookingDate}}. I am checking my schedule now and I shall let you know the moment I have confirmed it."},
    {"id": "kincare.booking.confirm", "title": "It is official: I have {{kinName}} on my books", "is_sec": False, "body": "Hello {{kinfolkName}}. Well!!!! I have officially confirmed your {{serviceType}} for {{kinName}} on {{bookingDate}} at {{bookingTime}}. I shall be there to take care of everything."},
    {"id": "kincare.booking.cancel", "title": "Update: Your visit for {{kinName}} has been cancelled", "is_sec": False, "body": "Hello {{kinfolkName}}. I am writing to confirm that the {{serviceType}} for {{kinName}} on {{bookingDate}} has been cancelled. I shall keep an eye out for your next request."},
    {"id": "kincare.unavailable", "title": "Status: I am unavailable for this request", "is_sec": False, "body": "Hello {{kinfolkName}}. I checked my schedule and I am unable to handle the {{serviceType}} on {{bookingDate}}. I am much obliged for your understanding."},
    {"id": "kincare.changed", "title": "Update: Details have changed for {{kinName}}'s visit", "is_sec": False, "body": "Hello {{kinfolkName}}. I have updated the details for your {{serviceType}} on {{bookingDate}}. Please review the new times to ensure they suit your family."},
    {"id": "kincare.note.kinfolk", "title": "New Note: I have received your message regarding {{kinName}}", "is_sec": False, "body": "Hello. I just received the note you left for me on {{kinName}}'s booking. I shall take care of those specifics during my visit."},
    {"id": "kincare.auntie.on_my_way", "title": "Ooooweeeee: I am on my way to see {{kinName}}", "is_sec": False, "body": "Hello. I am headed over right now for our {{serviceType}}! I shall see {{kinName}} very shortly."},
    {"id": "kincare.auntie.arrived", "title": "I'm here! {{kinName}} was waiting for me", "is_sec": False, "body": "Hello. I just walked in and what a time we are already having! {{kinName}} greeted me at the door with {{arrivalBehavior}}."},
    {"id": "kincare.auntie.departed", "title": "Status: I have finished up my visit with {{kinName}}", "is_sec": False, "body": "Hello. I have finished our {{serviceType}} and {{kinName}} is all settled. (Waste removed. Door locked. Key secured in the lockbox.)"},
    {"id": "kincare.report.sent", "title": "{{kinName}} is all settled and loved", "is_sec": False, "body": "Hello {{kinfolkName}}. I have just finished up my visit with {{kinName}} and what a joy it was! I have left a full KinTale for you to read."},
    {"id": "kincare.upcoming.reminder", "title": "Reminder: I will be seeing {{kinName}} on {{bookingDate}}", "is_sec": False, "body": "Hello {{kinfolkName}}. This is a quick note to say I am looking forward to our {{serviceType}} on {{bookingDate}} at {{bookingTime}}."},
    {"id": "schedule.upcoming.digest", "title": "Schedule: Your upcoming visits at Tribe Tails Pet Care", "is_sec": False, "body": "Hello. Here is the digest of the Kin I shall be looking after for you this week. I am much obliged for your trust."},
    {"id": "kintale.published", "title": "Ooooweeeee: A new story about {{kinName}} is ready", "is_sec": False, "body": "Hello {{kinfolkName}}. Well!!!! I just posted a new KinTale for you. {{kinName}} was being such a character today (I am screaming at how cute they were being!)."},
    {"id": "kintale.comment.added", "title": "Interaction: New comments on {{kinName}}'s story", "is_sec": False, "body": "Hello. I see you have left a comment on our latest KinTale! I shall read it right quick and get back to you."},
    {"id": "invoice.new", "title": "Your invoice for {{kinName}}'s care is ready", "is_sec": False, "body": "Hello {{kinfolkName}}. I have prepared your invoice ({{invoiceNumber}}) for {{amount}} due on {{dueDate}}. I shall handle the logistics with care."},
    {"id": "invoice.updated", "title": "Update: I have modified your invoice for {{kinName}}", "is_sec": False, "body": "Hello. I have updated the details on invoice {{invoiceNumber}}. Please review the changes at your earliest convenience."},
    {"id": "quote.accepted", "title": "WIN!!!! I am so excited to see {{kinName}}", "is_sec": False, "body": "Hello! I am much obliged. I just saw that you accepted the quote for {{kinName}}'s care. I should think we are going to have an absolute TIME!"},
    {"id": "quote.denied", "title": "Status: Regarding your recent quote", "is_sec": False, "body": "Hello. I have received your update regarding the quote. I shall keep an eye out for any future requests your family may have."},
    {"id": "invoice.charge.failed", "title": "Security: Payment failed for invoice {{invoiceNumber}}", "is_sec": True, "body": "Hello {{kinfolkName}}. I take this seriously. The payment for {{invoiceNumber}} did not go through. I shall need this handled right quick so I can focus on the Kin."},
    {"id": "invoice.payment.applied", "title": "Confirmation: I have received your payment", "is_sec": False, "body": "Hello. I am much obliged! I have received your payment for invoice {{invoiceNumber}}. Thank you for your support of Tribe Tails Pet Care."},
    {"id": "invoice.reminder", "title": "Reminder: Your invoice for {{kinName}} is ready", "is_sec": False, "body": "Hello {{kinfolkName}}. This is a quick note regarding invoice {{invoiceNumber}} for {{amount}}. I shall handle the care while you handle the logistics."},
    {"id": "invoice.overdue", "title": "Security: Your invoice for {{kinName}}'s care is overdue", "is_sec": True, "body": "Hello {{kinfolkName}}. I noticed the invoice for {{kinName}}'s care on {{bookingDate}} is still outstanding. I shall need that handled right quick. Not on my watch."},
    {"id": "pets.updated", "title": "Update: I have modified {{kinName}}'s details", "is_sec": False, "body": "Hello. I have updated the profile for {{kinName}} in my system. I shall ensure my care matches these new specifics."},
    {"id": "profile.updated", "title": "Update: I have updated your family profile", "is_sec": False, "body": "Hello. I have saved the changes to your family profile details. I am much obliged for keeping your information current."},
    {"id": "pet.marked.inactive", "title": "Status: Update regarding {{kinName}}'s status", "is_sec": False, "body": "Hello. I have marked {{kinName}} as inactive in my records. I shall keep their memories close and look forward to seeing your other Kin."},
    {"id": "rating.submitted.bad", "title": "Feedback: I want to make this right", "is_sec": False, "body": "Hello {{kinfolkName}}. I just saw your feedback. That one was all on me! I shall reach out directly to see how I can do better for your family."},
    {"id": "rating.submitted.good", "title": "Ooooweeeee: Much obliged for the kind words", "is_sec": False, "body": "Hello! I am screaming! I just saw your review and I am so glad {{kinName}} and I had such a great time. Thank you!"},
    {"id": "newsletter.announcement", "title": "Announcement: News from Tribe Tails Pet Care", "is_sec": False, "body": "Hello. I have some exciting updates to share with the whole Tribe! I shall keep this brief so you can get back to your Kin."},
    {"id": "survey.event", "title": "Survey: I would love to hear from you", "is_sec": False, "body": "Hello. I am always looking for ways to improve Tribe Tails Pet Care. I should think your feedback would help me greatly."},
    {"id": "marketing.optin", "title": "Newsletter: Stay in the loop with Auntie", "is_sec": False, "body": "Hello. I would love to keep you updated on all the Kin stories and business news. I shall only send the good stuff!"},
]

zip_filename = "Tribe_Tails_Pet_Care_Complete_Templates.zip"
with zipfile.ZipFile(zip_filename, 'w') as zf:
    for k in keys:
        folder = k["id"].replace(".", "_")
        subj = k["title"]
        body = k["body"]
        
        # Email TXT
        zf.writestr(f"{folder}/email.txt", f"Subject: {subj}\n\n{body}\n\nView details here: []\n\nWith care, Auntie\n\nTribe Tails Pet Care..Your Kin’s Favorite Auntie")
        
        # Email HTML
        html_body = f"<p>{body}</p>"
        if k["is_sec"]:
            html_body += "<div class='alert-box'><strong>Not on my watch:</strong> If you did NOT request this, report the unauthorized attempt immediately: <a href='[]'>Report Investigation</a></div>"
        html_body += "<a href='[]' class='button'>View Details</a>"
        
        zf.writestr(f"{folder}/email.html", generate_html(subj, html_body, k["is_sec"]))
        
        # SMS
        zf.writestr(f"{folder}/sms.txt", f"Auntie here! {subj}. Check it here: []")
        
        # Push
        zf.writestr(f"{folder}/push.txt", f"{subj}. Tap to see details.")

print(f"Success! Generated {zip_filename} in the current directory.")