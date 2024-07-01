import json
from requests import request
import psycopg2

def parseSignals():
    print("Getting Signals...")
    signals = json.loads(open('./signals.json', encoding='utf-8').read())
    
    # Connect to postgresql database
    cur = psycopg2.connect(dbname="smo", user="postgres", password="Tgymr0447Emre12917!!%%", host="192.168.137.1", port="5432").cursor()
    print("Connected to database")
    both = []
    for signal in signals:
        if signal['prevFinalized']:
            #print(signal['name'] + " is prev-finalized")
            result = True
            #if signal['name'] == "L4_50":
            #    print(signal)
            # Get existing connections
            cur.execute("SELECT * FROM signal_connections WHERE next = %s", (signal['name'],))
            rows = cur.fetchall()
            if (len(signal['prevSignals']) > 0):
                if len(rows) == 0:
                    #print("Connection does not exist for " + signal['name'])
                    result = False
                    pass
                else:
                    # Initialize a set to keep track of unique connections to delete
                    connections_to_delete = set()
                    
                    # Iterate through each signal connection
                    for signal_connection in signal['prevSignals']:
                        # Assume the connection needs to be deleted unless found in rows
                        connection_exists = False
                        
                        # Check if the current signal_connection is in any row
                        for row in rows:
                            if signal_connection in row:
                                connection_exists = True
                                #print(f"Connection already exists between {signal['name']} and {signal_connection}")
                                break
                        
                        # If the connection was not found, add it to the set for deletion
                        if not connection_exists:
                            connections_to_delete.add((signal['name'], signal_connection))
                    
                    # Delete each unique connection
                    for name, connection in connections_to_delete:
                        cur.execute("DELETE FROM signal_connections WHERE next = %s AND prev = %s", (name, connection))
                        print(f"Deleted connection between {name} and {connection}")
            else:
                cur.execute("DELETE FROM signal_connections WHERE next = %s", (signal['name'],))
            # Finalize the signal
            if result:
                cur.execute("UPDATE signals SET prev_finalized = TRUE WHERE name = %s", (signal['name'],))
                #print("Finalized " + signal['name'])
        if signal['nextFinalized']:
            result = True
            #print(signal['name'] + " is next-finalized")
            # Get existing connections
            cur.execute("SELECT * FROM signal_connections WHERE prev = %s", (signal['name'],))
            rows = cur.fetchall()
            if (len(signal['nextSignals']) > 0):
                if len(rows) == 0:
                    #print("Connection does not exist for " + signal['name'])
                    result = False
                    pass
                else:
                    # Initialize a set to keep track of unique connections to delete
                    connections_to_delete = set()

                    # Iterate through each signal connection
                    for signal_connection in signal['nextSignals']:
                        # Assume the connection needs to be deleted unless found in rows
                        connection_exists = False

                        # Check if the current signal_connection is in any row
                        for row in rows:
                            if signal_connection in row:
                                connection_exists = True
                                #print(f"Connection already exists between {signal['name']} and {signal_connection}")
                                break

                        # If the connection was not found, add it to the set for deletion
                        if not connection_exists:
                            connections_to_delete.add((signal['name'], signal_connection))

                    # Delete each unique connection
                    for name, connection in connections_to_delete:
                        cur.execute("DELETE FROM signal_connections WHERE prev = %s AND next = %s", (name, connection))
                        print(f"Deleted connection between {name} and {connection}")
            else:
                cur.execute("DELETE FROM signal_connections WHERE prev = %s", (signal['name'],))
            # Finalize the signal
            if result:
                cur.execute("UPDATE signals SET next_finalized = TRUE WHERE name = %s", (signal['name'],))
                #print("Finalized " + signal['name'])
        if signal['prevFinalized'] and signal['nextFinalized']:
            both.append(signal['name'])
    for signal in both:
        print(signal + " is both prev-finalized and next-finalized")
    # Ask commit
    commit = input("Commit changes? (y/n): ")
    if commit == "y":
        cur.connection.commit()
        print("Changes committed")
    else:
        print("Changes not committed")

if __name__ == '__main__':
    parseSignals()