import requests
from typing import Dict, List, Any

class LeanIXClient:
    def __init__(self, tenant: str, token: str):
        """Initialize the LeanIX GraphQL client."""
        self.api_url = f"https://{tenant}.leanix.net/services/pathfinder/v1/graphql"
        self.headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        }

    def _run_query(self, query: str, variables: Dict[str, Any]) -> Dict[str, Any]:
        """Execute a GraphQL query."""
        response = requests.post(
            self.api_url, headers=self.headers, json={"query": query, "variables": variables}
        )
        response.raise_for_status()
        data = response.json()
        if "errors" in data:
            raise Exception(data["errors"])
        return data["data"]

    def get_business_capability(self, bc_id: str) -> Dict[str, Any]:
        """Fetch one business capability (with direct children and linked applications)."""
        query = """
        query($bcId: ID!) {
          businessCapability(id: $bcId) {
            id
            name
            children {
              id
              name
            }
            applications {
              edges {
                node {
                  id
                  name
                  lifecyclePhase
                }
              }
            }
          }
        }
        """
        data = self._run_query(query, {"bcId": bc_id})
        return data.get("businessCapability")

    def get_all_children_recursive(self, bc_id: str) -> List[Dict[str, Any]]:
        """Recursively get all children of a business capability."""
        results = []
        stack = [bc_id]
        visited = set()

        while stack:
            current_id = stack.pop()
            if current_id in visited:
                continue
            visited.add(current_id)

            bc = self.get_business_capability(current_id)
            if not bc:
                continue

            results.append(bc)

            children = bc.get("children", [])
            for child in children:
                stack.append(child["id"])

        return results

    def get_all_apps_for_bc_tree(self, root_bc_id: str) -> Dict[str, List[Dict[str, Any]]]:
        """Return a map of capability name → applications."""
        bc_list = self.get_all_children_recursive(root_bc_id)
        apps_map = {}

        for bc in bc_list:
            apps = [edge["node"] for edge in bc.get("applications", {}).get("edges", [])]
            apps_map[bc["name"]] = apps

        return apps_map


# === Example usage ===
if __name__ == "__main__":
    TENANT = "<your-tenant>"  # e.g. fidelity.leanix.net
    TOKEN = "<your-api-token>"
    ROOT_BC_ID = "<your-bc-factsheet-id>"

    client = LeanIXClient(TENANT, TOKEN)

    apps_by_capability = client.get_all_apps_for_bc_tree(ROOT_BC_ID)

    for bc_name, apps in apps_by_capability.items():
        print(f"\n📂 {bc_name} — {len(apps)} applications")
        for app in apps:
            print(f"  • {app['name']} ({app['lifecyclePhase']})")
