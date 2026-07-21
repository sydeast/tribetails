#!/bin/bash
# AuntieOS Firestore Import Runner
# ================================
# Place your serviceAccount.json in this directory, then run:
#   chmod +x run_import.sh
#   ./run_import.sh

set -e

# Check if serviceAccount.json exists
if [ ! -f "serviceAccount.json" ]; then
    echo "❌ ERROR: serviceAccount.json not found"
    echo ""
    echo "📥 GET SERVICE ACCOUNT KEY:"
    echo "   1. Visit: https://console.firebase.google.com/project/auntieos-ttpc/settings/serviceaccounts/adminsdk"
    echo "   2. Click 'Generate new private key'"
    echo "   3. Save as serviceAccount.json in this directory"
    echo ""
    exit 1
fi

echo "🚀 Starting AuntieOS → Firestore Import"
echo "Project: auntieos-ttpc"
echo ""

# Step 1: Dry run test with one collection
echo "📋 Step 1: Dry run test (kinfolk collection)"
python3 migration/scripts/import_to_firestore.py --creds serviceAccount.json --dry-run --only kinfolk
echo ""

# Step 2: Import test collection
echo "📤 Step 2: Import test collection (kinfolk)"
python3 migration/scripts/import_to_firestore.py --creds serviceAccount.json --only kinfolk
echo ""

# Step 3: Ask user to verify
echo "🔍 Step 3: Verify in Firebase Console"
echo "   Check: https://console.firebase.google.com/project/auntieos-ttpc/firestore"
echo ""
read -p "✅ Does the kinfolk collection look correct? (y/n): " -n 1 -r
echo ""

if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "❌ Stopping import. Check the data and try again."
    exit 1
fi

# Step 4: Import all collections
echo ""
echo "📤 Step 4: Importing all collections..."
python3 migration/scripts/import_to_firestore.py --creds serviceAccount.json

echo ""
echo "✅ Import complete!"
echo "   View data: https://console.firebase.google.com/project/auntieos-ttpc/firestore"
echo ""
echo "🔍 Run verification check:"
echo "   python3 migration/scripts/verify_import.py --creds serviceAccount.json"
